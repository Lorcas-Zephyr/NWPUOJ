# Submission code editor

CodeMirror 6 is bundled locally for the submission form. Exact dependency versions
are pinned in package-lock.json. Production needs only the checked-in files under
../static-libs/noj-code-editor and does not request scripts from a CDN.

Rebuild: `npm ci && npm run build` from this directory (Node 18 or later).

src/bootstrap.js provides the existing createCodeEditor/onEditorLoaded interface,
editor preferences, fullscreen controls, and a textarea fallback. src/editor.js
implements the CodeMirror adapter and C/C++, Java, and Python syntax support.
Dependency licenses are distributed alongside the bundle.
