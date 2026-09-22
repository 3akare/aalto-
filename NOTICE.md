# Third-party notices

Aalto's own source is MIT (see [LICENSE](LICENSE)). It bundles two third-party
works, each under its own terms.

## Cormorant Garamond

Copyright 2015 The Cormorant Project Authors, licensed under the SIL Open Font
License 1.1. The full licence text ships with the font at
[`extension/fonts/OFL.txt`](extension/fonts/OFL.txt).

Used for headings in the extension popup and on the site.

## Instrument Sans

Copyright 2022 The Instrument Sans Project Authors
(<https://github.com/Instrument/instrument-sans>), licensed under the SIL Open
Font License 1.1.

The body face on the website. It stands in for Styrene B, which is the body face
in the design reference and is not freely licensed. Self-hosted in
[`web/public/assets/fonts/`](web/public/assets/fonts/) rather than loaded from
Google Fonts, so the page owes nothing to a third party on the one load that
matters.

## Remix Icon

Copyright 2020 Remix Design, licensed under the Apache License 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>).

The icons are inlined as SVG path data in
[`extension/icons.js`](extension/icons.js) rather than loaded as files, because
Manifest V3's content security policy blocks remote resources and the popup has
no build step to bundle them.
