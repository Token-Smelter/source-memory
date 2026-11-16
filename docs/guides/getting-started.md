# Getting started

Start with Docker or use an existing Neo4j server from Node.js. Both examples ingest a fictional turn, then search for it. Run commands from the repository root.

## Quick start (Docker)

Requires Docker with Compose. Create a `.env` file beside `docker-compose.yml` containing one line, `NEO4J_PASSWORD=<a long random password>`. `.env` is git-ignored; never commit it.

```sh
docker compose up -d neo4j
docker compose run --rm memory init --scope default
docker compose run --rm -T memory ingest --scope default < examples/turn.json
echo '{"query":"dashboard"}' | docker compose run --rm -T memory recall --scope default
```

The container uses [`config/docker.json`](../../config/docker.json), which reaches Neo4j by its Compose service name. Neo4j's Bolt port is also published on `127.0.0.1` only, so host-side tools can share the same database.

## Quick start (host Node.js)

Requires Node.js 22+ and a Neo4j 5.26+ server.

```sh
npm ci
export SOURCE_MEMORY_NEO4J_PASSWORD=...   # use your normal secret mechanism
node bin/memory.mjs init --config config/host.json --scope default
node bin/memory.mjs ingest --config config/host.json --scope default --input examples/turn.json
echo '{"query":"dashboard"}' | node bin/memory.mjs recall --config config/host.json --scope default
```

`--config` defaults to `$SOURCE_MEMORY_CONFIG`. The package executable is `source-memory`.


See [configuration and CLI reference](../reference/cli.md) for scope grants and endpoint settings.
