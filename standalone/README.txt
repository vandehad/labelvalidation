BIN CONVERSION STATION
======================

A local web app for converting a site from old Zone-Aisle-Column-Shelf bins
to the new {Zone}{aisle}{column}{letter}01 format, with a guaranteed
one-for-one match.


RUNNING IT

  Double-click index.html. It opens in Edge or Chrome. That is all -
  no install, no server, no internet connection needed.

  Keep the three files together:
      index.html      the page
      app.js          the logic
      lib.js          Excel read/write

  Work is saved in the browser as you scan. Use the same browser and the
  same machine for a given site, and take a backup at the end of each shift
  (tab 4). Clearing browser site data will erase an unbacked-up session.


THE FOUR STEPS

  1 - GENERATE LABELS
      Feed in the old bin list (paste, or load .xlsx / .csv / .txt) and the
      app works out every zone/aisle/column and how tall each one is.

      Shelf count basis:
        Tallest anywhere   every column gets the same number of letters.
                           Print more than you need; the extras get
                           deleted in step 3. This is the safe choice.
        Tallest per zone    same idea, per zone.
        Tallest per aisle   same idea, per aisle.
        Actual per column   exactly what the old data shows. Smallest
                           print run, but no slack if a rack is taller
                           than the old data claims.

      Z is kept aside for floor level wherever a shelf 0 exists, so a
      26-shelf column with a floor position is capped at 25 letters + Z.
      Anything that would need more than 26 is flagged.

  2 - SCAN AND PAIR
      Set the zone and aisle you are standing in, then scan the OLD label
      and the NEW label for each shelf. Enter (from the scanner) moves
      between the fields and saves the pair.

      Refused automatically, with a buzz:
        - an old bin already paired
        - a new label already used on another bin
        - a new label from a different zone or aisle than your location
        - a new label that is not in Z##/##/L/## form
        - old and new identical (a double-scan)

      Undo last removes the most recent pair.

  3 - RECONCILE
      Load the list of labels actually printed. The app reports:
        - labels never scanned  -> unused, delete these bins
        - labels scanned but not printed -> unexpected, investigate
      When there are no unexpected labels and the pair count equals the
      used count, it reports 1 : 1.

  4 - EXPORT
      Cross-reference as .xlsx or .csv, plus a JSON session backup.


SCANNER

  Any USB scanner in keyboard-wedge mode. It must send Enter (CR) after
  each scan - most do by default. Tab works too. Test by scanning into
  the Old bin field: the code should land and the cursor jump to New bin.


FILE FORMATS

  Reads  .xlsx (including files Excel wrote), .csv, .txt
  Writes .xlsx and .csv

  On import the app scans each row for the first cell that looks like a
  bin, so extra columns and headers do not matter.


TESTED

  XLSX writer   verified by opening generated files in Excel and openpyxl,
                including quotes, ampersands and angle brackets in values
  XLSX reader   verified against a real Excel-produced file (2,004 rows,
                deflated, shared strings)
  Label rules   10 checks - uniform/per-zone/per-aisle/actual basis,
                floor-level Z handling, manual ranges
  Scan rules    9 checks - every refusal case above
  Reconcile     9 checks - unused, unexpected, and a clean 1:1 run

  Run them again with:
      node test_app.mjs
      node test_rec.mjs
      node test_xlsx.mjs


LIMITS

  - 26 shelves per column is the ceiling; A-Z runs out beyond that.
    Columns exceeding it are flagged rather than silently truncated.
  - .xlsx reading needs a current Edge, Chrome or Firefox. If a file
    will not load, save it as CSV.
  - One browser profile holds one session at a time. Two people scanning
    at once should use separate machines and their exports merged.
