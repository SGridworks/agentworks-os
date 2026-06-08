# Fixture: inspector-listening

Exercises the `inspector-exposed` trust warning. There is no static artifact
to commit because the trust aggregator probes a live socket — the test must
open one on `127.0.0.1:9229` for the duration of the assertion.

## Usage from a vitest run

```ts
import { startInspectorStub, stopInspectorStub } from "./open-inspector.mjs";

beforeAll(async () => {
  await startInspectorStub();
});
afterAll(async () => {
  await stopInspectorStub();
});
```

The stub binds to `127.0.0.1:9229` only — never `0.0.0.0`. If port 9229 is
already in use the stub throws; the test should treat that as a hard failure
rather than a pass.

## Why a stub instead of `--inspect`

Spawning Node with `--inspect` works but interleaves a debugger banner into
test output and races with vitest's own worker pool. A bare TCP listener on
the inspector port is sufficient: the trust aggregator's check is a port
probe, not a CDP handshake.

## Cleanup invariant

Tests MUST call `stopInspectorStub()` in `afterAll`. A leaked listener will
cause subsequent runs to fail the `port already in use` guard above and will
make any production daemon running on the same host falsely trip the
`inspector-exposed` warning until the orphan socket is closed.
