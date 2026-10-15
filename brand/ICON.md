# FamilyStories brand art

The app's mark is a **vintage microphone whose head is a little house** —
a family's voices, recorded at home. Flat, bold, no words.

## Colours (Homeroom brand palette)

| Colour | Hex | Used for |
| --- | --- | --- |
| Cream | `#FFFEEA` | the mark on dark, featured light ground |
| Black | `#000000` | icon tile, featured dark ground, light-version mark |
| Yellow | `#FFEE6F` | disc behind the mark (light featured), sound waves (dark featured) |

Pairings used: Cream + Black, Black + Yellow.

## Files

- `icon.svg` / `icon.png` — app icon, 1024×1024, square with sharp corners
  (the platform rounds the tile). Wired up as `icon.image` in `dapp.json`;
  `icon.emoji` (🎙️) stays as the fallback.
- `featured-light.svg` / `featured-light.png` — featured illustration for the
  Homeroom directory, light version: black mark on cream, yellow disc behind,
  black sound waves. 1600×1000.
- `featured-dark.svg` / `featured-dark.png` — dark version: cream mark on
  black, yellow sound waves. 1600×1000.

The featured PNGs are not shown anywhere by the app itself; the app's owner
attaches them as the directory's featured images after merge.

## Re-rendering

The SVGs are the sources. Render with any SVG rasterizer, e.g.:

```sh
rsvg-convert -w 1024 -h 1024 brand/icon.svg -o brand/icon.png
rsvg-convert -w 1600 -h 1000 brand/featured-light.svg -o brand/featured-light.png
rsvg-convert -w 1600 -h 1000 brand/featured-dark.svg -o brand/featured-dark.png
```

Keep the PNGs opaque and `icon.png` under 256 KB (the platform's limit for
`icon.image`).
