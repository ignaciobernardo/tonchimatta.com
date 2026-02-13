#!/usr/bin/env python3
"""
generate_photos.py — Scans public/background/photos/ for images,
reads EXIF metadata (date, GPS), converts HEIC→JPEG, reads category
assignments from photos_config.json, and outputs photos_data.js.

Usage:
    source .venv/bin/activate
    python3 generate_photos.py

Workflow:
  1. Add photos to public/background/photos/
  2. Run this script (converts HEIC, reads EXIF, updates _all_photos list)
  3. Edit photos_config.json to assign photos to favorites/collections
  4. Run script again to regenerate
  5. Reload index.html
"""

import os
import json
import sys
from datetime import datetime

try:
    from PIL import Image
    from PIL.ExifTags import TAGS, GPSTAGS
except ImportError:
    print("Error: Pillow is required. Install it:")
    print("  python3 -m venv .venv && source .venv/bin/activate && pip install Pillow pillow-heif")
    sys.exit(1)

# Try importing HEIF support
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF_SUPPORT = True
except ImportError:
    HEIF_SUPPORT = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PHOTOS_DIR = os.path.join(BASE_DIR, "public", "background", "photos")
CONFIG_FILE = os.path.join(BASE_DIR, "photos_config.json")
OUTPUT_JSON = os.path.join(PHOTOS_DIR, "photos_data.json")
OUTPUT_JS = os.path.join(BASE_DIR, "photos_data.js")
SUPPORTED_EXTENSIONS = {'.jpeg', '.jpg', '.png', '.gif', '.webp'}
HEIC_EXTENSIONS = {'.heic', '.heif'}


def convert_heic_to_jpeg(filepath):
    """Convert a HEIC file to JPEG, preserving EXIF. Returns new path."""
    if not HEIF_SUPPORT:
        print(f"  Warning: Skipping {os.path.basename(filepath)} — install pillow-heif for HEIC support")
        return None

    new_path = os.path.splitext(filepath)[0] + ".jpeg"
    print(f"  Converting HEIC -> JPEG: {os.path.basename(filepath)}")
    img = Image.open(filepath)
    exif_data = img.info.get('exif', None)
    if exif_data:
        img.save(new_path, "JPEG", quality=90, exif=exif_data)
    else:
        img.save(new_path, "JPEG", quality=90)
    img.close()
    os.remove(filepath)
    return new_path


def extract_exif(filepath):
    """Extract date and GPS from EXIF. Returns dict with 'date' and 'geo'."""
    result = {"date": None, "geo": None}
    try:
        img = Image.open(filepath)
        exif_raw = img._getexif()
        if not exif_raw:
            img.close()
            return result

        exif = {}
        for tag_id, value in exif_raw.items():
            tag = TAGS.get(tag_id, tag_id)
            exif[tag] = value

        # Date
        for date_tag in ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime']:
            if date_tag in exif:
                try:
                    dt = datetime.strptime(str(exif[date_tag]), '%Y:%m:%d %H:%M:%S')
                    result["date"] = dt.isoformat()
                except Exception:
                    pass
                break

        # GPS
        if 'GPSInfo' in exif:
            gps_info = {}
            for key, val in exif['GPSInfo'].items():
                tag = GPSTAGS.get(key, key)
                gps_info[tag] = val

            def to_degrees(value):
                d, m, s = value
                return float(d) + float(m) / 60 + float(s) / 3600

            if 'GPSLatitude' in gps_info and 'GPSLongitude' in gps_info:
                lat = to_degrees(gps_info['GPSLatitude'])
                lon = to_degrees(gps_info['GPSLongitude'])
                if gps_info.get('GPSLatitudeRef', 'N') == 'S':
                    lat = -lat
                if gps_info.get('GPSLongitudeRef', 'E') == 'W':
                    lon = -lon
                result["geo"] = {"lat": round(lat, 6), "lon": round(lon, 6)}

        img.close()
    except Exception as e:
        print(f"  EXIF error for {os.path.basename(filepath)}: {e}")

    return result


def load_config(all_filenames):
    """Load photos_config.json. Creates it if missing. Auto-updates _all_photos."""
    default_config = {
        "_instructions": "Assign photos to categories by adding filenames to each array below. "
                         "After editing, run: source .venv/bin/activate && python3 generate_photos.py",
        "favorites": [],
        "collections": {
            "flowers": [],
            "food": [],
            "friends": []
        },
        "_all_photos": sorted(all_filenames)
    }

    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'w') as f:
            json.dump(default_config, f, indent=2)
        print(f"  Created {CONFIG_FILE} — edit it to assign photos to categories")
        return default_config

    with open(CONFIG_FILE, 'r') as f:
        config = json.load(f)

    # Auto-update _all_photos with any new files
    existing = set(config.get("_all_photos", []))
    current = set(all_filenames)
    new_photos = current - existing
    if new_photos:
        config["_all_photos"] = sorted(current)
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
        print(f"  Added {len(new_photos)} new photo(s) to _all_photos in config")

    return config


def main():
    if not os.path.isdir(PHOTOS_DIR):
        print(f"Photos directory not found: {PHOTOS_DIR}")
        sys.exit(1)

    # Step 1: Convert any HEIC files to JPEG
    for f in os.listdir(PHOTOS_DIR):
        ext = os.path.splitext(f)[1].lower()
        if ext in HEIC_EXTENSIONS:
            convert_heic_to_jpeg(os.path.join(PHOTOS_DIR, f))

    # Step 2: Scan all supported image files
    files = sorted([
        f for f in os.listdir(PHOTOS_DIR)
        if os.path.splitext(f)[1].lower() in SUPPORTED_EXTENSIONS
    ])

    # Step 3: Load config for category assignments
    config = load_config(files)
    favorites_set = set(config.get("favorites", []))
    collections_config = config.get("collections", {})

    # Step 4: Process each photo
    photos = []
    for f in files:
        filepath = os.path.join(PHOTOS_DIR, f)
        exif = extract_exif(filepath)

        # Fallback: file modification time
        if not exif["date"]:
            mtime = os.path.getmtime(filepath)
            exif["date"] = datetime.fromtimestamp(mtime).isoformat()

        # Determine categories
        cats = []
        if f in favorites_set:
            cats.append("favorites")
        for col_name, col_files in collections_config.items():
            if f in col_files:
                cats.append(col_name)

        photo = {
            "file": f,
            "date": exif["date"],
        }
        if exif["geo"]:
            photo["geo"] = exif["geo"]
        if cats:
            photo["categories"] = cats

        photos.append(photo)

    # Sort by date
    photos.sort(key=lambda p: p["date"])

    # Save JSON (for reference)
    with open(OUTPUT_JSON, 'w') as out:
        json.dump(photos, out, indent=2)

    # Save JS file (loaded by index.html via <script> tag)
    js_data = json.dumps(photos, indent=2)
    with open(OUTPUT_JS, 'w') as out:
        out.write("// Auto-generated by generate_photos.py — do not edit manually\n")
        out.write(f"const PHOTOS_RAW_DATA = {js_data};\n")

    # Stats
    fav_count = sum(1 for p in photos if "favorites" in (p.get("categories") or []))
    col_counts = {}
    for p in photos:
        for c in (p.get("categories") or []):
            if c != "favorites":
                col_counts[c] = col_counts.get(c, 0) + 1

    print(f"\n✓ {len(photos)} photos processed")
    print(f"  Favorites: {fav_count}")
    for name, count in col_counts.items():
        print(f"  {name.capitalize()}: {count}")
    print(f"  → {OUTPUT_JS}")
    print("  Now reload index.html to see updated gallery.")


if __name__ == "__main__":
    main()
