#!/bin/sh

rm -f addon.xpi

for size in 16 32 48 64 128; do
  rm -f icon-${size}.png
  convert -background none -resize ${size}x${size} icon.svg icon-${size}.png || exit 1
  optipng -o2 icon-${size}.png || exit 1
done

zip -r addon.xpi manifest.json background.js api/* icon*.png README.md LICENSE