# tools/vendor — third-party scripts inlined into a generated page

The story graph page draws with Cytoscape.js and lays out with dagre. A page must open from
`file://` with no network, so both UMD builds are committed here and inlined into the HTML as
`<script>` text. Neither library is a Node dependency: they are read as bytes, never imported.

| file | package | version | upstream | licence | sha256 |
| --- | --- | --- | --- | --- | --- |
| `cytoscape.min.js` | `cytoscape` | 3.34.4 | https://unpkg.com/cytoscape@3.34.4/dist/cytoscape.min.js | MIT (full text in the file header) | `081591ab735b2b6a3b31a3c60f8f3a3e2fee8c92939e0c7820ad1208571b6cd8` |
| `cytoscape-dagre.min.js` | `cytoscape-dagre` | 4.0.1 | https://unpkg.com/cytoscape-dagre@4.0.1/dist/cytoscape-dagre.min.js | MIT (`cytoscape-dagre.LICENSE`) | `ec671a41d2bfcac580352e2997797793949e3489cecaf347fc48670d4bd456b0` |
| `cytoscape-dagre.LICENSE` | `cytoscape-dagre` | 4.0.1 | https://unpkg.com/cytoscape-dagre@4.0.1/LICENSE | MIT | `c8f8d9008103872d6686927c1646c9267726c1f1c44a8f625399325b6d190837` |

`cytoscape-dagre`'s banner says 4.0.0; 4.0.1 is the published package version and the dist is
what that release ships. The dagre core is bundled inside the extension's dist, so there is no
third file.

**To update:** replace the file with the new upstream URL, keep the file name, then refresh the
version and sha256 rows here (`shasum -a 256 tools/vendor/*`) and run
`node script/run-tests.mjs graphpage` — the suite pins the inlined bytes and the versions the
page prints.
