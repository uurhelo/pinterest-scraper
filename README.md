# pinterest-scraper

A Node.js script that bulk downloads images from Pinterest boards to your computer. Supports single boards, multiple boards, or an entire profile at once. Remembers what it already downloaded so you can resume or re-run it without re-downloading anything.

## Requirements

- [Node.js](https://nodejs.org) (v18 or newer recommended)
- A Pinterest account (you log in through the browser window it opens)

## Setup

1. Clone or download this repo
2. Open a terminal in the folder and install dependencies:

```
npm install playwright
npx playwright install chromium
```

## Usage

```
node pinterest-scraper.js
```

You'll be asked to pick a mode:

**Mode 1 — Single board**
Paste one board URL, e.g. `https://www.pinterest.com/username/board-name/`

**Mode 2 — Multiple boards**
Paste several board URLs separated by commas

**Mode 3 — Full profile**
Paste a profile URL, e.g. `https://www.pinterest.com/username/`
The script will find all your boards automatically and download them all.

After choosing a mode, a browser window will open. Log in to Pinterest if needed, then come back to the terminal and press Enter to start.

## How files are saved

Images are saved in folders named after the board, nested under the username:

```
username/
  board-name/
    pin_123.jpg
    pin_456.jpg
  another-board/
    pin_789.png
  board-with-sections/
    pin_001.jpg        ← pins not in any section
    section-one/
      pin_002.jpg
    section-two/
      pin_003.jpg
```

Each board folder also gets a `state.json` and `metadata.json` file that track what's been downloaded. If you run the script again on the same board, it will skip already-downloaded pins.

## Notes

- The script stops collecting pins as soon as Pinterest's "Find more ideas" section appears, so you only get pins from the actual board — not recommendations
- Boards that contain sub-sections (like collaborative boards) are handled automatically; each section is scraped into its own subfolder
- Failed downloads are silently skipped and will be retried on the next run
- The `pinterest-profile/` folder stores your browser login session so you don't have to log in every time

