# Jupiter activity chart

The profile chart turns real GitHub contribution data into a calendar around Jupiter. Each orbit is one calendar month and each star is one day. Larger, brighter stars indicate more contributions; a quiet day remains a small dot. The month labels run from oldest on the inside to newest on the outside. Days run clockwise from the top gap.

The chart covers the current calendar month through today and the previous eleven months. Its date range is printed on the image. This can differ from GitHub's native rolling-year graph. The source is GitHub's GraphQL contribution calendar; GitHub's own contribution rules and visibility settings still apply. Only dates and aggregate counts are used. No repository names or private activity details are included.

## Automatic updates

The [update workflow](../.github/workflows/activity.yml) runs daily at 00:17 UTC, around 08:17 in China. GitHub may delay scheduled runs. It also runs when the renderer changes and can be started manually from the repository's **Actions → Update Jupiter activity → Run workflow** page.

Each run checks the renderer, reads the contribution calendar, and generates `assets/activity-light.svg` and `assets/activity-dark.svg`, plus a taller `-mobile.svg` version of each theme. It commits only those four images when their contents change. The README selects the matching image for the viewer's screen width and light or dark theme. GitHub's image cache may take time to display an update.

The workflow uses the repository's built-in `GITHUB_TOKEN` with permission to update its files. No personal access token, external image host, or third-party contribution service is required. If fetching fails, the workflow fails without publishing replacement charts. Public repositories with no activity for 60 days may have scheduled workflows disabled by GitHub; use the Actions page to re-enable the schedule if necessary.

## Customize the design

The dependency-free renderer is in [scripts/activity.mjs](../scripts/activity.mjs). Its theme colors, orbit geometry, planet illustration, text, and contribution-to-star mapping can be edited there. The main profile banners are separate assets in `assets/jupiter-light.svg` and `assets/jupiter-dark.svg`.

Run the checks with:

```sh
node --test scripts/activity.test.mjs
```

Render from a saved GraphQL calendar response without credentials:

```sh
node scripts/activity.mjs --input calendar.json --output-dir assets
```

To read GitHub directly, set `GH_TOKEN` in your environment, then run:

```sh
node scripts/activity.mjs --fetch Jupiter363 --output-dir assets
```

The custom chart is part of the profile README. GitHub's native contribution graph remains under GitHub's control.
