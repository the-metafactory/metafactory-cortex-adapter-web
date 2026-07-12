# metafactory-cortex-adapter-web

The **cortex web/SSE surface adapter**, delivered as an installable plugin bundle.

Extracted from `the-metafactory/cortex` `src/adapters/web/` per [ADR-0024](https://github.com/the-metafactory/cortex/blob/main/docs/adr/0024-pluggable-surface-adapters.md) (pluggable surface plugins). cortex declares this bundle as an `arc-manifest.yaml` dependency; `arc upgrade cortex` installs it, and the cortex plugin loader loads it as a first-party adapter.

- **Type:** surface adapter (both dispatch source + sink)
- **Surface:** generic web/SSE — HTTP ingress + SSE broadcast-push
- **Compat:** declares a `SURFACE_SDK_VERSION` range in `cortex-plugin.yaml`

Naming follows the [component repo-naming standard](https://github.com/the-metafactory/compass/blob/main/standards/component-repo-naming.md) (`metafactory-<owner>-<type>-<name>`).
