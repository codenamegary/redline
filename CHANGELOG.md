# Changelog

## [1.2.2](https://github.com/codenamegary/redline/compare/v1.2.1...v1.2.2) (2026-09-12)


### Bug Fixes

* **skill:** warn that unknown utilities in [@apply](https://github.com/apply) silently kill artifact styling ([3fd7d58](https://github.com/codenamegary/redline/commit/3fd7d58ef4b0fdb13159d8e43ac1b004a3596452))

## [1.2.1](https://github.com/codenamegary/redline/compare/v1.2.0...v1.2.1) (2026-09-12)


### Bug Fixes

* **api:** require cwd on artifact create and persist it to meta.json ([#58](https://github.com/codenamegary/redline/issues/58)) ([ddad4c8](https://github.com/codenamegary/redline/commit/ddad4c89109910f23afba1a2b9eeb550b29f6700))

## [1.2.0](https://github.com/codenamegary/redline/compare/v1.1.1...v1.2.0) (2026-09-12)


### Features

* **server:** strip redline session-name prefixes from artifact titles at creation ([93d0773](https://github.com/codenamegary/redline/commit/93d077389182737b71a8c2a33d0429300818fc72))
* **ui:** add the redline mark to the page header ([93d0773](https://github.com/codenamegary/redline/commit/93d077389182737b71a8c2a33d0429300818fc72))
* **ui:** mark in the review header, artifact title as the tab title ([93d0773](https://github.com/codenamegary/redline/commit/93d077389182737b71a8c2a33d0429300818fc72))

## [1.1.1](https://github.com/codenamegary/redline/compare/v1.1.0...v1.1.1) (2026-09-11)


### Bug Fixes

* **server:** serve web-root static files (favicons) from the not-found handler ([#53](https://github.com/codenamegary/redline/issues/53)) ([cd0d0ae](https://github.com/codenamegary/redline/commit/cd0d0aef1a658c4a373567a04d707fa18f4c589e))

## [1.1.0](https://github.com/codenamegary/redline/compare/v1.0.0...v1.1.0) (2026-09-11)


### Features

* **review:** collapsible, resizable comments sidebar with auto-growing reply box ([#52](https://github.com/codenamegary/redline/issues/52)) ([dbf7f36](https://github.com/codenamegary/redline/commit/dbf7f369610990fd5dbd7ab341dc39d4dcebf55c))
* **ui:** replace favicon with option E dark variant asset set ([#50](https://github.com/codenamegary/redline/issues/50)) ([e379dfa](https://github.com/codenamegary/redline/commit/e379dfa4ea24ac6356cd8899fbd3febc6a62337d))


### Bug Fixes

* **ui:** approval state on gallery cards — version drawer + seal ([#49](https://github.com/codenamegary/redline/issues/49)) ([5df9e66](https://github.com/codenamegary/redline/commit/5df9e66022e005d2e75df38a54a363977fc91421))

## [1.0.0](https://github.com/codenamegary/redline/compare/v0.7.0...v1.0.0) (2026-09-10)


### ⚠ BREAKING CHANGES

* the pi extension and opencode plugin no longer ship.

### Code Refactoring

* remove host plugins, Notify, origin, and the opencode-sdk lane adapter ([#47](https://github.com/codenamegary/redline/issues/47)) ([585ff91](https://github.com/codenamegary/redline/commit/585ff910a9b4595d614f2600ac06b9cebc703df0))

## [0.7.0](https://github.com/codenamegary/redline/compare/v0.6.0...v0.7.0) (2026-09-10)


### Features

* **iteration:** self-heal failed rounds, worker liveness, live session log, stop ([#45](https://github.com/codenamegary/redline/issues/45)) ([366b09c](https://github.com/codenamegary/redline/commit/366b09c1e9493c4e4378326453c1af82c1087839))

## [0.6.0](https://github.com/codenamegary/redline/compare/v0.5.5...v0.6.0) (2026-09-10)


### Features

* **review:** play ding when the ding checkbox is selected ([57df28e](https://github.com/codenamegary/redline/commit/57df28e8b4052a0da94a18ce0cfb94a20a80d7a4))

## [0.5.5](https://github.com/codenamegary/redline/compare/v0.5.4...v0.5.5) (2026-09-10)


### Bug Fixes

* **contracts:** accept null for iteratedAt ([#42](https://github.com/codenamegary/redline/issues/42)) ([6a1dabc](https://github.com/codenamegary/redline/commit/6a1dabc5ec5dbea09f0c8616566fee42004e606c))

## [0.5.4](https://github.com/codenamegary/redline/compare/v0.5.3...v0.5.4) (2026-09-09)


### Bug Fixes

* **installer:** install the web UI next to the binary ([#40](https://github.com/codenamegary/redline/issues/40)) ([afa6b89](https://github.com/codenamegary/redline/commit/afa6b893b751fa8efc0e31121cf466a9f9f23542))

## [0.5.3](https://github.com/codenamegary/redline/compare/v0.5.2...v0.5.3) (2026-09-09)


### Bug Fixes

* **skill:** bootstrap from the remote installer, not a repo clone ([#38](https://github.com/codenamegary/redline/issues/38)) ([51a17fb](https://github.com/codenamegary/redline/commit/51a17fb3371ff6ecf51be0a50fc98999709c93a9))

## [0.5.2](https://github.com/codenamegary/redline/compare/v0.5.1...v0.5.2) (2026-09-09)


### Bug Fixes

* **installer:** verify only the downloaded tarball against checksums.txt ([#36](https://github.com/codenamegary/redline/issues/36)) ([5fa5a14](https://github.com/codenamegary/redline/commit/5fa5a1495ce5dd47118be31222e03a10c84a9c40))

## [0.5.1](https://github.com/codenamegary/redline/compare/v0.5.0...v0.5.1) (2026-09-08)


### Bug Fixes

* **release:** package artifacts on bot-created releases ([#33](https://github.com/codenamegary/redline/issues/33)) ([bb85344](https://github.com/codenamegary/redline/commit/bb85344d84c3a15bf4b033d5500233b7d47cb8ae))

## [0.5.0](https://github.com/codenamegary/redline/compare/v0.4.1...v0.5.0) (2026-09-08)


### Features

* migrate frontend to React and restructure into a bun workspace monorepo ([#31](https://github.com/codenamegary/redline/issues/31)) ([d4909cd](https://github.com/codenamegary/redline/commit/d4909cd8853c18204fc25b130f2339743a409826))


### Bug Fixes

* **ui:** never block Iterate on agent attachment ([#28](https://github.com/codenamegary/redline/issues/28)) ([e8bc11e](https://github.com/codenamegary/redline/commit/e8bc11e10c2db458bb436e54ee4253cb80387f1d))

## [0.4.1](https://github.com/codenamegary/redline/compare/v0.4.0...v0.4.1) (2026-09-08)


### Bug Fixes

* **worker:** raise default agent duty timeout from 5m to 15m ([#25](https://github.com/codenamegary/redline/issues/25)) ([4497811](https://github.com/codenamegary/redline/commit/4497811e080f19c648ec70f5116d032ba14be78f))

## [0.4.0](https://github.com/codenamegary/redline/compare/v0.3.0...v0.4.0) (2026-09-08)


### Features

* **summary:** surface version asset counts on gallery cards and summaries ([#22](https://github.com/codenamegary/redline/issues/22)) ([826ef32](https://github.com/codenamegary/redline/commit/826ef32f6c47dbabd27f720966d533e0af22c664))

## [0.3.0](https://github.com/codenamegary/redline/compare/v0.2.0...v0.3.0) (2026-09-07)


### Features

* **skill:** Tailwind CDN base skeleton and component menu for artifacts ([#17](https://github.com/codenamegary/redline/issues/17)) ([d53a8c8](https://github.com/codenamegary/redline/commit/d53a8c8ce4b4be14b97616f7504f346c662ab061))

## [0.2.0](https://github.com/codenamegary/redline/compare/v0.1.0...v0.2.0) (2026-09-07)


### Features

* version-aware daemon and prebuilt-binary installer ([3809192](https://github.com/codenamegary/redline/commit/38091923c9cb7162f7abee55a6876cc3618fffc7))
