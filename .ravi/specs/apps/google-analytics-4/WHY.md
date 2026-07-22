# Why Google Analytics 4 is a Ravi App

GA4 is a reusable operational capability with reporting, discovery, admin and
audit surfaces. A native app makes those operations discoverable, typed and
permissioned without teaching agents to depend on SDE internals.

The migration remains parallel: SDE is evidence and fallback, while the native
client follows the current official REST contracts. Credentials are deliberately
deferred so the initial delivery can prove manifest, routing, endpoint mapping,
permission classes and failure behavior without exposing production authority.
