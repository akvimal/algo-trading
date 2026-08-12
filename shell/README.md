# shell

Not a system - just a static tab bar + iframes onto each system's already-independent frontend, so you don't have to juggle separate browser tabs/ports. Zero build step, zero framework: one `index.html`, served by nginx.

Each iframe points at `http://<host>:<port>`, where the ports match the `*_FRONTEND_PORT` values in `.env`. If you change those ports, update the `TABS` array at the top of `index.html`'s `<script>` block to match.

This intentionally stays this simple - see the "Frontend shell" decision in the project history for why a full merged single-page app was ruled out (it would couple the systems' frontends together, against the loose-coupling design elsewhere in this repo).
