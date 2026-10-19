# Third-party licences

## Bundled in this repository

| Component | Version | Licence | Where | Why here |
|---|---|---|---|---|
| Il2CppDumper | v6.7.46 (net7 build) | MIT (Perfare) | `tools/il2cppdumper/` | Produces `dump.cs` (types, fields, offsets, signatures). Small, managed, platform-neutral: it needs only the .NET SDK, which this repository already requires. |
| Mono.Cecil (+ Mdb, Pdb, Rocks) | shipped with Il2CppDumper | MIT (Jb Evain) | `tools/il2cppdumper/` | Il2CppDumper reads assemblies through it. |
| Cpp2IL | 2022.1.0-pre-release.21 | MIT (Sam Byass) | **not bundled** — downloaded by `inspect_game_code action=setup` | Produces method bodies. It ships one native binary per OS and CPU (15–17 MB each), so it is fetched per machine and checked against the digest in `tools/toolchain.json`. |

`tools/il2cppdumper/LICENSE` is the upstream MIT text. The Cpp2IL licence text is at
`https://github.com/SamboyCoding/Cpp2IL/blob/2022.1.0-pre-release.21/LICENSE`.

## Around this repository

| Component | Licence | Note |
|---|---|---|
| .NET SDK | MIT | Installed by the player, not shipped. `check_runtime` / `install_runtime` cover it. |
| The game's own code | DoubleCross | Never enters this repository. The dump lives under the product data root; see the design repository's `docs/decompilation-guide.md`. |
