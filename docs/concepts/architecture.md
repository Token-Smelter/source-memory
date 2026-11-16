# Concepts and architecture

Source Memory keeps original turns separate from interpretations so that a later reader can inspect the evidence behind a record.

## From source to recall

1. **Ingest** stores a turn and its entries, preserving their text and creating chunks for search. Stable caller identities make identical retries safe.
2. **Enrich** adds caller-supplied records such as decisions and outcomes, and explicit relationships such as `supersedes`. Evidence points to exact offsets in stored entries. The store validates the bundle; it does not independently verify the interpretation.
3. **Recall** searches lexical channels and, when configured, vector channels. It fuses results, optionally reranks them and expands relationships into evidence bundles. A partial result is not a complete graph.
4. **Show** retrieves a retained turn or record and its evidence for inspection.

For example, if a decision changes, retain the new conversation turn, add a new decision citing its source, and explicitly relate it to the earlier decision with `supersedes`. Similar wording or chronology alone does not create that link. See [record examples and exact contracts](../reference/cli.md#records-and-relations).

## Boundaries

A scope restricts the data addressed by a command; configured allowlists control access by this process. They do not isolate mutually untrusted processes running as the same user. Neo4j stores source text; configured embedding and reranking endpoints can receive it. Operators must protect the database, endpoints and credentials. Source Memory does not automatically extract records as part of the core CLI; the experimental [Pi integration](../INTEGRATION.md) is a separate host adapter.
