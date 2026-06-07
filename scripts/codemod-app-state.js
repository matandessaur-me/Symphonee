#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const ROOT = path.resolve(__dirname, '..');
const PARTS_DIR = path.join(ROOT, 'dashboard', 'public', 'app', 'src', 'parts');
const MANIFEST_PATH = path.join(PARTS_DIR, 'manifest.json');
const BUILT_APP_PATH = path.join(ROOT, 'dashboard', 'public', 'js', 'app.js');
const REPORT_PATH = path.join(ROOT, '.ai-workspace', 'app-state-codemod-report.json');
const STATE_PART = 'state.js';

const PARSER_PLUGINS = [
  'asyncGenerators',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'dynamicImport',
  'nullishCoalescingOperator',
  'objectRestSpread',
  'optionalCatchBinding',
  'optionalChaining',
  'topLevelAwait',
];

function parseScript(code, filename) {
  return parser.parse(code, {
    sourceType: 'script',
    plugins: PARSER_PLUGINS,
    errorRecovery: false,
    ranges: true,
    sourceFilename: filename,
  });
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function readPart(partName) {
  return fs.readFileSync(path.join(PARTS_DIR, partName), 'utf8');
}

function writePart(partName, code) {
  fs.writeFileSync(path.join(PARTS_DIR, partName), code);
}

function memberForState(name) {
  return t.memberExpression(t.identifier('state'), t.identifier(name));
}

function cloneStateMember(name) {
  return t.memberExpression(t.identifier('state'), t.identifier(name));
}

function collectMutableGlobals(ast) {
  const globals = [];
  traverse(ast, {
    Program(programPath) {
      const bindings = programPath.scope.bindings;
      for (const [name, binding] of Object.entries(bindings)) {
        if (!binding.path.isVariableDeclarator()) continue;
        const decl = binding.path.parentPath.node;
        if (!t.isVariableDeclaration(decl)) continue;
        if (decl.kind !== 'let' && decl.kind !== 'var') continue;
        if (!binding.constant) {
          globals.push({
            name,
            kind: decl.kind,
            start: binding.identifier.start || 0,
          });
        }
      }
      programPath.stop();
    },
  });
  globals.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  return globals;
}

function isIdentifierInDeclarationPosition(path) {
  const parent = path.parentPath;
  if (!parent) return false;
  if (parent.isVariableDeclarator({ id: path.node })) return true;
  if (parent.isFunctionDeclaration({ id: path.node })) return true;
  if (parent.isFunctionExpression({ id: path.node })) return true;
  if (parent.isClassDeclaration({ id: path.node })) return true;
  if (parent.isClassExpression({ id: path.node })) return true;
  if (parent.isLabeledStatement({ label: path.node })) return true;
  if (parent.isCatchClause({ param: path.node })) return true;
  if (
    (parent.isFunction() || parent.isArrowFunctionExpression()) &&
    parent.node.params.includes(path.node)
  ) {
    return true;
  }
  return false;
}

function shouldSkipIdentifier(path) {
  const parent = path.parentPath;
  if (!parent) return true;
  if (isIdentifierInDeclarationPosition(path)) return true;
  if (parent.isMemberExpression() && parent.node.property === path.node && !parent.node.computed) {
    return true;
  }
  if (parent.isOptionalMemberExpression && parent.isOptionalMemberExpression() && parent.node.property === path.node && !parent.node.computed) {
    return true;
  }
  if (parent.isObjectProperty()) {
    if (parent.node.key === path.node && !parent.node.computed) {
      if (!parent.node.shorthand) return true;
      return false;
    }
  }
  if (parent.isObjectMethod() && parent.node.key === path.node && !parent.node.computed) return true;
  if (parent.isClassMethod() && parent.node.key === path.node && !parent.node.computed) return true;
  if (parent.isClassProperty() && parent.node.key === path.node && !parent.node.computed) return true;
  if (parent.isImportSpecifier() || parent.isImportDefaultSpecifier() || parent.isImportNamespaceSpecifier()) return true;
  if (parent.isExportSpecifier()) return true;
  if (parent.isBreakStatement() || parent.isContinueStatement()) return true;
  return false;
}

function isWindowMemberAccess(path, globalSet) {
  const parent = path.parentPath;
  if (!parent || !parent.isMemberExpression()) return false;
  if (parent.node.property !== path.node || parent.node.computed) return false;
  const obj = parent.get('object');
  return obj.isIdentifier({ name: 'window' }) && globalSet.has(path.node.name);
}

function collectWindowCouplings(ast, globalSet) {
  const couplings = new Set();
  traverse(ast, {
    Identifier(path) {
      if (isWindowMemberAccess(path, globalSet)) {
        couplings.add(path.node.name);
      }
    },
  });
  return [...couplings].sort();
}

function replaceTopLevelDeclaration(path, mutableNames) {
  const original = path.node;
  const statements = [];

  for (const declarator of original.declarations) {
    if (!t.isIdentifier(declarator.id)) {
      statements.push(t.variableDeclaration(original.kind, [declarator]));
      continue;
    }

    const name = declarator.id.name;
    if (!mutableNames.has(name)) {
      statements.push(t.variableDeclaration(original.kind, [declarator]));
      continue;
    }

    const assignment = t.expressionStatement(
      t.assignmentExpression(
        '=',
        memberForState(name),
        declarator.init ? declarator.init : t.identifier('undefined')
      )
    );
    statements.push(assignment);
  }

  if (!statements.length) {
    path.remove();
    return;
  }

  if (original.leadingComments) statements[0].leadingComments = original.leadingComments;
  if (original.trailingComments) statements[statements.length - 1].trailingComments = original.trailingComments;

  path.replaceWithMultiple(statements);
}

function rewritePart(partName, code, mutableNames) {
  const declAst = parseScript(code, partName);
  traverse(declAst, {
    VariableDeclaration(path) {
      if (!path.parentPath.isProgram()) return;
      if (path.node.kind !== 'let' && path.node.kind !== 'var') return;
      const hasMutable = path.node.declarations.some((decl) => t.isIdentifier(decl.id) && mutableNames.has(decl.id.name));
      if (!hasMutable) return;
      replaceTopLevelDeclaration(path, mutableNames);
    },
  });

  const afterDecls = generate(declAst, { comments: true }).code;
  const ast = parseScript(afterDecls, partName);

  traverse(ast, {
    Identifier(path) {
      const { name } = path.node;
      if (!mutableNames.has(name)) return;
      if (shouldSkipIdentifier(path)) return;
      if (isWindowMemberAccess(path, mutableNames)) return;

      if (path.parentPath.isObjectProperty() && path.parent.shorthand && path.parent.value === path.node) {
        path.parentPath.node.shorthand = false;
        path.replaceWith(cloneStateMember(name));
        return;
      }

      const binding = path.scope.getBinding(name);
      if (binding) {
        if (binding.scope.parent !== null) return;
        if (
          binding.path.isFunctionDeclaration() ||
          binding.path.isClassDeclaration() ||
          binding.path.isCatchClause() ||
          binding.path.isImportSpecifier() ||
          binding.path.isImportDefaultSpecifier() ||
          binding.path.isImportNamespaceSpecifier()
        ) {
          return;
        }
      }

      path.replaceWith(cloneStateMember(name));
    },
  });

  return generate(ast, { comments: true }).code;
}

function collectBareReferenceFindings(partName, code, mutableNames) {
  const ast = parseScript(code, partName);
  const findings = [];
  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      if (!mutableNames.has(name)) return;
      if (shouldSkipIdentifier(path)) return;
      if (isWindowMemberAccess(path, mutableNames)) return;
      if (path.parentPath.isObjectProperty() && path.parent.shorthand && path.parent.value === path.node) return;

      const binding = path.scope.getBinding(name);
      if (binding && binding.scope.parent !== null) {
        findings.push({
          name,
          line: path.node.loc && path.node.loc.start ? path.node.loc.start.line : null,
          reason: 'shadowed-local',
        });
      } else {
        findings.push({
          name,
          line: path.node.loc && path.node.loc.start ? path.node.loc.start.line : null,
          reason: 'bare-reference',
        });
      }
    },
  });
  return findings;
}

function ensureStatePart(manifest) {
  const next = manifest.filter((part) => part !== STATE_PART);
  next.unshift(STATE_PART);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(next, null, 2) + '\n');
  writePart(STATE_PART, 'var state = {};\n');
  return next;
}

function main() {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });

  const builtCode = fs.readFileSync(BUILT_APP_PATH, 'utf8');
  const builtAst = parseScript(builtCode, BUILT_APP_PATH);
  const globals = collectMutableGlobals(builtAst);
  const mutableNames = new Set(globals.map((item) => item.name));
  const manifest = loadManifest();
  const nextManifest = ensureStatePart(manifest);

  const rewrittenParts = [];
  const leftoverFindings = [];
  const windowCouplings = new Set(collectWindowCouplings(builtAst, mutableNames));

  for (const partName of nextManifest) {
    if (partName === STATE_PART) continue;
    const original = readPart(partName);
    const partAst = parseScript(original, partName);
    collectWindowCouplings(partAst, mutableNames).forEach((name) => windowCouplings.add(name));
    const rewritten = rewritePart(partName, original, mutableNames);
    writePart(partName, rewritten);
    rewrittenParts.push(partName);
  }

  for (const partName of nextManifest) {
    const code = readPart(partName);
    const findings = collectBareReferenceFindings(partName, code, mutableNames);
    if (findings.length) {
      leftoverFindings.push({
        part: partName,
        findings,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mutableGlobalCount: globals.length,
    mutableGlobals: globals.map((item) => item.name),
    rewrittenParts,
    windowCouplings: [...windowCouplings].sort(),
    leftovers: leftoverFindings,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main();
