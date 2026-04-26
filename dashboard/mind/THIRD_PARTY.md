# Third-party design credit

Symphonee Mind is a clean-room Node/TypeScript reimplementation of design ideas
from **graphify** by Safi Shamsi (https://github.com/safishamsi/graphify), an
MIT-licensed Python package. No graphify code is included; the patterns we
borrowed are listed below so future maintainers can compare against the source
of record.

## Patterns adapted

- **Three-label confidence taxonomy** (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`)
  on every edge, with a numeric `confidenceScore` 0.1-1.0. See `schema.js`.

- **ID normalization + label-keyed deduplication** to merge entities that two
  extractors named slightly differently or that came back with chunk-suffixed
  IDs from a parallel-subagent extractor. See `ids.js::normalizeId` and
  `ids.js::deduplicateByLabel` (mirrors `graphify/build.py::_normalize_id` and
  `deduplicate_by_label`).

- **Refuse-silent-shrinkage merge invariant**: if an incremental rebuild
  produces fewer nodes than the previous graph without an explicit prune list,
  abort. See `build.js::buildMerge` (mirrors `graphify/build.py::build_merge`).

- **Topology-only clustering**: communities are found by edge density (Louvain
  / Leiden), no embeddings, no vector store. See `cluster.js`. The
  oversized-community split (any community above 25% of total node count gets
  a second-pass Louvain) is also lifted from graphify.

- **God nodes + surprising connections**: degree centrality for hubs,
  cross-community edges for unexpected bridges. See `analyze.js`.

- **Provenance on every node** (`source`, `sourceLocation`, `createdBy`,
  `createdAt`) so an agent reading the graph can always answer "who taught
  the brain this and from what?".

- **Security guards** ported in spirit from `graphify/security.py`:
  `sanitizeLabel` (control-char strip, 256 char cap, HTML escape) and
  `validateUrl` (http/https only, blocks loopback / private / metadata
  endpoints). See `security.js`.

- **Per-file content-hash cache** so re-running on a 1k-file corpus does not
  re-spend on 950 unchanged files. See `manifest.js`.

## Patterns NOT used

- Vector embeddings (intentionally; topology is the similarity signal).
- Whisper transcription (out of Phase 1 scope).
- Neo4j export (niche; we ship JSON canonical + Obsidian later if asked).
- Python sidecar (Symphonee is Electron; we want one runtime).

## License

graphify is MIT-licensed. This reimplementation does not ship any graphify
code, but the architectural debt is acknowledged here per the spirit of the
license.
