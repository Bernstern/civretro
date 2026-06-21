#!/usr/bin/env python3
"""
Civ 7 save file analyzer.
Decompresses and inspects the game state from a .Civ7Save file.

Format (confirmed via pydt/civ7-save-parser + iqqmuT/civ7-save-editor):
  [4]   "CIV7" magic
  [4]   unknown (possibly version)
  [...] metadata block (typed binary chunks in 5 groups)
  [6]   compressed block marker: 00 00 01 00 78 9C
        ↑ this is [u32LE chunk_size=65536][zlib magic]
  [...] chunked deflate stream:
          repeat: [u32LE chunk_size][chunk_size bytes of deflate]
          until:  [u32LE <= 1] (terminator)
  [...] footer
"""

import zlib
import struct
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Known 4-byte chunk marker IDs (hashed keys in the game state)
# ---------------------------------------------------------------------------
MARKERS = {
    bytes([0x9d, 0x2c, 0xe6, 0xbd]): "GAME_TURN",
    bytes([0x84, 0x84, 0xc6, 0xd0]): "GAME_AGE",
    bytes([0x0f, 0xfb, 0x8c, 0xc1]): "LEADER_NAME",
    bytes([0x76, 0x97, 0x40, 0xde]): "CIV_NAME",
    bytes([0x23, 0x1e, 0x99, 0x37]): "GOLD_TREASURY",
    bytes([0x50, 0x3c, 0xa8, 0x4a]): "ACCUMULATED_INFLUENCE",
    # Owns the FXSBLKED array of per-entity "last-touched turn" values.
    # max(non-FF values) = last completed turn; +1 for autosaves gives UI turn number.
    bytes([0xcb, 0x51, 0x98, 0xf0]): "TURN_HISTORY",
}

FXSBLKED = b"FXSBLKED"

COMPRESSED_MARKER = bytes([0x00, 0x00, 0x01, 0x00, 0x78, 0x9C])


def load_save(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def find_compressed_block(data: bytes) -> int:
    """Return offset of the 6-byte COMPRESSED_MARKER, or -1."""
    return data.find(COMPRESSED_MARKER)


def read_chunks(data: bytes, start: int) -> tuple[list[bytes], int]:
    """
    Read the chunked deflate stream starting at `start`.
    Returns (list_of_raw_chunk_bytes, end_offset).
    """
    chunks = []
    offset = start
    while True:
        if offset + 4 > len(data):
            break
        chunk_size = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        if chunk_size <= 1:
            break
        chunks.append(data[offset : offset + chunk_size])
        offset += chunk_size
    return chunks, offset


def decompress_game_state(chunks: list[bytes]) -> bytes:
    combined = b"".join(chunks)
    return zlib.decompressobj(wbits=47).decompress(combined)


def decode_encoded_u32(raw: int) -> int:
    """Firaxis encoded u32: value in upper 24 bits; low byte 0xFF means add 1."""
    val = (raw >> 8) & 0xFFFFFF
    if (raw & 0xFF) == 0xFF:
        val += 1
    return val


def extract_current_turn(dec: bytes) -> int | None:
    """
    Extract the current game turn from the decompressed game state.

    Strategy: find the FXSBLKED array attached to the TURN_HISTORY chunk
    (marker cb5198f0, type 0x402), which lives within ~256 bytes of the
    GAME_TURN marker. The array stores "last-touched turn" per entity as
    plain u32 LE, with unused slots filled with 0xFFFFFFFF.

    Returns max(non-FF values). For autosaves this equals turn−1 (save is
    created before players act); for end-of-turn manual saves it equals the
    displayed turn number.
    """
    GAME_TURN_MARKER = bytes([0x9d, 0x2c, 0xe6, 0xbd])
    gt_pos = dec.find(GAME_TURN_MARKER)
    if gt_pos < 0:
        return None
    # FXSBLKED sits within 256 bytes after GAME_TURN
    search_start = gt_pos
    search_end   = min(len(dec), gt_pos + 256)
    fx_pos = dec.find(FXSBLKED, search_start, search_end)
    if fx_pos < 0:
        return None
    # Skip: FXSBLKED(8) + array_type_u32(4) = 12 bytes to first element
    arr_start = fx_pos + 12
    best = None
    offset = arr_start
    ff_run = 0  # consecutive 0xFFFFFFFF count
    while offset + 4 <= len(dec):
        val = struct.unpack_from("<I", dec, offset)[0]
        if val == 0xFFFFFFFF:
            ff_run += 1
            if ff_run >= 4:        # terminal sentinel block — stop here
                break
            offset += 4
            continue
        ff_run = 0
        if val > 0x10000:          # sanity: turns shouldn't exceed 65536
            break
        if best is None or val > best:
            best = val
        offset += 4
        if offset - arr_start > 512 * 4:
            break
    return best


def decode_chunk_value(dec: bytes, pos: int) -> dict:
    """
    Parse a single chunk at `pos`.

    Observed layouts:
      type 8    → [4 marker][4 type=8][4 unk][4 encoded_u32]
      type 0x407 → [4 marker][4 type][4 unk1][4 unk2][8 "FXSBLKED"][4 encoded_u32][...]
      type 0x400 → [4 marker][4 type][4 unk1][4 unk2][4 unk3][4 unk4][8 "FXSBLKED"][...]
    """
    if pos + 12 > len(dec):
        return {"offset": pos, "type": None, "value": None, "raw": None}

    chunk_type = struct.unpack_from("<I", dec, pos + 4)[0]
    unk1 = struct.unpack_from("<I", dec, pos + 8)[0]

    if chunk_type == 8:
        data_start = pos + 12
        if data_start + 4 <= len(dec):
            raw = struct.unpack_from("<I", dec, data_start)[0]
            return {"offset": pos, "type": chunk_type, "value": decode_encoded_u32(raw),
                    "raw": dec[data_start:data_start+4].hex()}

    elif chunk_type == 0x407:
        # [marker4][type4][unk4][unk4][FXSBLKED 8 bytes][encoded_u32 4 bytes]
        val_start = pos + 24  # 4+4+4+4+8
        if val_start + 4 <= len(dec):
            raw = struct.unpack_from("<I", dec, val_start)[0]
            return {"offset": pos, "type": chunk_type, "value": decode_encoded_u32(raw),
                    "raw": dec[val_start:val_start+4].hex()}

    elif chunk_type == 0x400:
        # [marker4][type4][unk4][unk4][unk4][unk4][FXSBLKED 8 bytes][encoded_u32 4 bytes]
        val_start = pos + 32  # 4+4+4+4+4+4+8
        if val_start + 4 <= len(dec):
            raw = struct.unpack_from("<I", dec, val_start)[0]
            return {"offset": pos, "type": chunk_type, "value": decode_encoded_u32(raw),
                    "raw": dec[val_start:val_start+4].hex()}

    # Fallback: return raw bytes for inspection
    return {"offset": pos, "type": chunk_type, "value": None,
            "raw": dec[pos+4:pos+36].hex()}


def find_marker_values(dec: bytes) -> dict:
    """Scan for all known markers and decode their values."""
    results = {}
    for marker_bytes, name in MARKERS.items():
        hits = [m.start() for m in re.finditer(re.escape(marker_bytes), dec)]
        entries = [decode_chunk_value(dec, pos) for pos in hits]
        results[name] = entries
    return results


def dump_marker_context(dec: bytes, marker_bytes: bytes, name: str, n: int = 3):
    """Hex dump the bytes around the first n occurrences of a marker."""
    hits = [m.start() for m in re.finditer(re.escape(marker_bytes), dec)]
    print(f"\n--- {name} context (first {min(n, len(hits))} of {len(hits)} hits) ---")
    for pos in hits[:n]:
        chunk = dec[pos:pos+40]
        hex_str = " ".join(f"{b:02x}" for b in chunk)
        chunk_type = struct.unpack_from("<I", dec, pos+4)[0] if pos+8 <= len(dec) else 0
        print(f"  0x{pos:08x}: {hex_str}  (type=0x{chunk_type:x})")


def readable_strings(data: bytes, min_len: int = 7, limit: int = 60) -> list[str]:
    return [
        s.decode("ascii", errors="replace")
        for s in re.findall(b"[ -~]{" + str(min_len).encode() + b",}", data)
    ][:limit]


def hex_dump(data: bytes, offset: int = 0, length: int = 256) -> str:
    lines = []
    for i in range(0, length, 16):
        row = data[offset + i : offset + i + 16]
        if not row:
            break
        hex_part = " ".join(f"{b:02x}" for b in row)
        asc_part = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
        lines.append(f"  {offset+i:08x}: {hex_part:<48}  {asc_part}")
    return "\n".join(lines)


def analyze(path: str):
    print(f"=== Civ7 Save Analyzer ===")
    print(f"File: {path}")

    data = load_save(path)
    print(f"File size: {len(data):,} bytes ({len(data)/1024/1024:.2f} MB)")

    # Validate magic
    magic = data[:4]
    print(f"Magic: {magic} {'✓' if magic == b'CIV7' else '✗ NOT a Civ7 save'}")

    # Find compressed block
    marker_pos = find_compressed_block(data)
    if marker_pos < 0:
        print("ERROR: Compressed block marker not found — unknown format variant")
        return
    print(f"Compressed block starts at: 0x{marker_pos:06x} ({marker_pos:,})")
    print(f"Header/metadata size: {marker_pos:,} bytes")

    # Read and decompress chunks
    chunks, end_offset = read_chunks(data, marker_pos)
    print(f"Chunks: {len(chunks)}, total compressed: {sum(len(c) for c in chunks):,} bytes")
    print(f"Footer starts at: 0x{end_offset:06x} ({len(data)-end_offset} footer bytes)")

    dec = decompress_game_state(chunks)
    print(f"Decompressed game state: {len(dec):,} bytes ({len(dec)/1024/1024:.2f} MB)")

    turn = extract_current_turn(dec)
    if turn is not None:
        print(f"Last-completed turn: {turn}  (UI turn ≈ {turn} for manual saves, {turn+1} for autosaves)")
    else:
        print("Last-completed turn: (not found)")

    # Hex dump of decompressed start
    print(f"\n--- Decompressed data (first 128 bytes) ---")
    print(hex_dump(dec, 0, 128))

    # Readable strings in first 20KB of game state
    print(f"\n--- Readable strings in first 20KB of game state ---")
    for s in readable_strings(dec[:20000]):
        print(f"  {s}")

    # Dump raw context for debugging unknown types
    for marker_bytes, name in MARKERS.items():
        dump_marker_context(dec, marker_bytes, name, n=2)

    # Decoded values summary
    print(f"\n--- Known game state values ---")
    marker_results = find_marker_values(dec)
    for name, entries in marker_results.items():
        decoded = [e["value"] for e in entries if e["value"] is not None]
        failed  = [e for e in entries if e["value"] is None]
        if decoded:
            print(f"  {name} ({len(entries)} hits): {decoded}")
        elif failed:
            print(f"  {name} ({len(entries)} hits): type=0x{failed[0]['type']:x}, "
                  f"raw={failed[0]['raw']}")
        else:
            print(f"  {name}: 0 hits")

    return dec


def compare_saves(path_a: str, path_b: str):
    """Decompress two saves and compare all known marker values side by side."""
    print(f"\n=== Comparing saves ===")
    print(f"  A: {path_a}")
    print(f"  B: {path_b}")

    def get_values(path):
        data = load_save(path)
        marker_pos = find_compressed_block(data)
        chunks, _ = read_chunks(data, marker_pos)
        dec = decompress_game_state(chunks)
        return find_marker_values(dec)

    va = get_values(path_a)
    vb = get_values(path_b)

    for name in MARKERS.values():
        vals_a = [e["value"] for e in va.get(name, []) if e["value"] is not None]
        vals_b = [e["value"] for e in vb.get(name, []) if e["value"] is not None]
        changed = vals_a != vals_b
        tag = " ← CHANGED" if changed else ""
        print(f"\n  {name}:{tag}")
        print(f"    A: {vals_a}")
        print(f"    B: {vals_b}")


def scan_turn_in_metadata(data: bytes, compressed_start: int):
    """
    Scan the metadata (pre-compression) section for turn-like numeric values
    using the [len][00 00 60][u32 value] record format we observed there.
    Prints all records whose value looks like a plausible turn number (1-300).
    """
    print("\n--- Turn candidates in metadata section ---")
    pos = 0
    found = 0
    while pos < compressed_start - 8:
        if data[pos+1] == 0x00 and data[pos+2] == 0x00 and data[pos+3] == 0x60:
            slen = data[pos]
            val  = struct.unpack_from("<I", data, pos+4)[0]
            if 1 <= val <= 300 and slen > 0 and slen < 200:
                s_end = pos + 8 + slen
                if s_end <= compressed_start:
                    label = data[pos+8:s_end].rstrip(b"\x00").decode("ascii", errors="replace")
                    if label and not label.startswith("{"):  # skip JSON blobs
                        print(f"  0x{pos:06x}: val={val:4d}  key={repr(label)}")
                        found += 1
        pos += 1
    if not found:
        print("  (none found)")


def find_player_strings(dec: bytes):
    """Scan decompressed game state for player-identifying strings."""
    print("\n--- Player-related strings in decompressed game state ---")
    # Look for LEADER_ / CIV_ prefixed strings
    for match in re.finditer(b'LEADER_[A-Z_]+|CIVILIZATION_[A-Z_]+|PLAYER_[A-Z0-9_]+', dec):
        print(f"  0x{match.start():08x}: {match.group().decode()}")
        if match.start() > 0x200000:  # stop after 2MB scan
            break


def check_all_saves(paths: list[str]):
    """
    Decompress each save and report all known marker values.
    Good for cross-validating which marker is actually GAME_TURN.
    """
    for path in paths:
        print(f"\n{'='*60}")
        print(f"  {Path(path).name}")
        data = load_save(path)
        mp = find_compressed_block(data)
        chunks, _ = read_chunks(data, mp)
        dec = decompress_game_state(chunks)
        turn = extract_current_turn(dec)
        print(f"    last_completed_turn: {turn}")
        results = find_marker_values(dec)
        for name, entries in results.items():
            vals = [e["value"] for e in entries if e["value"] is not None]
            if vals:
                print(f"    {name}: {vals[:10]}")
            else:
                print(f"    {name}: {len(entries)} hits, no decoded values")


if __name__ == "__main__":
    if len(sys.argv) == 3:
        compare_saves(sys.argv[1], sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == "--all":
        check_all_saves(sys.argv[2:] if len(sys.argv) > 2 else [
            "saves/ConfuciusAnt100.Civ7Save",
            "saves/LafayetteExp1.Civ7Save",
            "saves/AutoSave_01_0060.Civ7Save",
        ])
    elif len(sys.argv) >= 2 and sys.argv[1] == "--find-turn-marker":
        # Strategy: collect all [4-byte marker][type=8][4-byte unk][4-byte encoded val]
        # tuples from ConfuciusAnt100 (expected turn ~100) and LafayetteExp1 (turn ~1).
        # A real turn counter will be a marker whose value ~= 100 in ant100
        # and ~= 1 in Exp1.

        def collect_type8_chunks(dec: bytes) -> dict:
            """Find all type-8 chunks; return {marker_hex: [decoded_values]}."""
            results: dict = {}
            for i in range(0, len(dec) - 16, 4):
                chunk_type = struct.unpack_from("<I", dec, i + 4)[0]
                if chunk_type == 8:
                    marker = dec[i:i+4].hex()
                    raw    = struct.unpack_from("<I", dec, i + 12)[0]
                    val    = decode_encoded_u32(raw)
                    results.setdefault(marker, []).append(val)
            return results

        files = {
            "ant100": "saves/ConfuciusAnt100.Civ7Save",
            "exp1":   "saves/LafayetteExp1.Civ7Save",
            "auto60": "saves/AutoSave_01_0060.Civ7Save",
        }
        decoded = {}
        # Use same-game autosaves for cross-reference (all Lafayette multiplayer game)
        files = {
            "exp01":  "saves/LafayetteExp1.Civ7Save",      # Exp turn ~1
            "auto35": "saves/AutoSave_01_0035.Civ7Save",   # Exp turn 35
            "auto50": "saves/AutoSave_01_0050.Civ7Save",   # Exp turn 50
            "auto60": "saves/AutoSave_01_0060.Civ7Save",   # Exp turn 60
        }
        for label, path in files.items():
            data = load_save(path)
            mp = find_compressed_block(data)
            chunks, _ = read_chunks(data, mp)
            dec = decompress_game_state(chunks)
            decoded[label] = collect_type8_chunks(dec)
            print(f"Loaded {label}: {len(decoded[label])} unique type-8 markers")

        # Find markers whose decoded values are ALL THE SAME within each file
        # (a constant per file), and that constant increases exp1 < auto35 < auto50 < auto60
        print("\nMarkers consistent with a turn counter (constant within file, increasing across files):")
        e1  = decoded["exp01"]
        a35 = decoded["auto35"]
        a50 = decoded["auto50"]
        a60 = decoded["auto60"]
        found_any = False
        for marker in e1:
            ve1  = e1.get(marker, [])
            v35  = a35.get(marker, [])
            v50  = a50.get(marker, [])
            v60  = a60.get(marker, [])
            if not (ve1 and v35 and v50 and v60):
                continue
            # All values within each file must be identical
            if not (len(set(ve1))==1 and len(set(v35))==1
                    and len(set(v50))==1 and len(set(v60))==1):
                continue
            c1, c35, c50, c60 = ve1[0], v35[0], v50[0], v60[0]
            if c1 < c35 < c50 < c60:
                print(f"  marker={marker}  exp1={c1} ({len(ve1)}x)  "
                      f"auto35={c35} ({len(v35)}x)  auto50={c50} ({len(v50)}x)  "
                      f"auto60={c60} ({len(v60)}x)")
                found_any = True
        if not found_any:
            # Relax: just monotonically increasing, no uniformity within file
            print("  (none with uniform values — relaxing to just monotonically increasing medians)")
            for marker in e1:
                ve1  = e1.get(marker, [])
                v35  = a35.get(marker, [])
                v50  = a50.get(marker, [])
                v60  = a60.get(marker, [])
                if not (ve1 and v35 and v50 and v60):
                    continue
                c1, c35, c50, c60 = (sorted(v)[len(v)//2] for v in [ve1,v35,v50,v60])
                if c1 < c35 < c50 < c60 and c60 - c1 > 30:
                    print(f"    marker={marker}  exp1={c1}  auto35={c35}  "
                          f"auto50={c50}  auto60={c60}")
        check_all_saves(sys.argv[2:] if len(sys.argv) > 2 else [
            "saves/ConfuciusAnt100.Civ7Save",
            "saves/LafayetteExp1.Civ7Save",
            "saves/AutoSave_01_0060.Civ7Save",
        ])
    elif len(sys.argv) >= 2 and sys.argv[1] == "--near-game-turn":
        # Anchor on the GAME_TURN marker in each file, then scan ±window bytes
        # for any u32 value that increases monotonically with turn number.
        # GAME_TURN itself = 4 (player count). The real turn should be near it.
        GAME_TURN_MARKER = bytes([0x9d, 0x2c, 0xe6, 0xbd])
        WINDOW = 512

        saves = [
            ("exp01",  "saves/LafayetteExp1.Civ7Save"),
            ("auto35", "saves/AutoSave_01_0035.Civ7Save"),
            ("auto50", "saves/AutoSave_01_0050.Civ7Save"),
            ("auto60", "saves/AutoSave_01_0060.Civ7Save"),
        ]

        windows: dict[str, list[bytes]] = {}  # label -> [window_bytes_per_hit]
        for label, path in saves:
            data = load_save(path)
            mp = find_compressed_block(data)
            chunks, _ = read_chunks(data, mp)
            dec = decompress_game_state(chunks)
            hits = [m.start() for m in re.finditer(re.escape(GAME_TURN_MARKER), dec)]
            print(f"{label}: GAME_TURN at {len(hits)} positions: {[f'0x{p:08x}' for p in hits]}")
            wins = []
            for pos in hits:
                s = max(0, pos - WINDOW)
                e = min(len(dec), pos + WINDOW + 4)
                wins.append((s, dec[s:e]))  # (anchor_offset, bytes)
            windows[label] = wins

        # For each hit in exp01, find corresponding hit in others (assume same hit index)
        # Then for each 4-byte aligned offset relative to anchor, compare u32 values
        print("\n--- Values that increase monotonically with turn (exp01 < auto35 < auto50 < auto60) ---")
        exp_wins = windows["exp01"]
        for hit_idx, (anchor_e1, win_e1) in enumerate(exp_wins):
            # Get matching windows from other files (by hit index)
            others = {}
            for lbl in ["auto35", "auto50", "auto60"]:
                w = windows[lbl]
                if hit_idx < len(w):
                    others[lbl] = w[hit_idx][1]  # (anchor, bytes) -> bytes
            if len(others) < 3:
                continue

            for rel in range(0, len(win_e1) - 3, 4):
                # Absolute offset within the anchor window for this file
                v_e1 = struct.unpack_from("<I", win_e1, rel)[0]
                # Try encoded u32
                ev_e1 = decode_encoded_u32(v_e1)

                row = {"exp01": (v_e1, ev_e1)}
                ok_plain = ok_enc = True
                for lbl, win in others.items():
                    if rel + 4 > len(win):
                        ok_plain = ok_enc = False; break
                    rv = struct.unpack_from("<I", win, rel)[0]
                    ev = decode_encoded_u32(rv)
                    row[lbl] = (rv, ev)

                if not ok_plain:
                    continue

                vv = [row[k][0] for k in ["exp01","auto35","auto50","auto60"] if k in row]
                ev = [row[k][1] for k in ["exp01","auto35","auto50","auto60"] if k in row]

                # Must increase and be in a reasonable turn range
                def is_turn_like(vals):
                    return (len(vals)==4
                            and vals[0] < vals[1] < vals[2] < vals[3]
                            and 1 <= vals[0] <= 100
                            and vals[3] - vals[0] > 20
                            and vals[3] <= 500)

                abs_off = anchor_e1 + rel
                if is_turn_like(vv):
                    print(f"  hit#{hit_idx} rel=+{rel:4d} abs=0x{abs_off:08x} [plain]    "
                          f"exp01={vv[0]}  35={vv[1]}  50={vv[2]}  60={vv[3]}")
                elif is_turn_like(ev):
                    print(f"  hit#{hit_idx} rel=+{rel:4d} abs=0x{abs_off:08x} [encoded]  "
                          f"exp01={ev[0]}  35={ev[1]}  50={ev[2]}  60={ev[3]}")

    elif len(sys.argv) >= 2 and sys.argv[1] == "--dump-turn-region":
        # Dump hex around the discovered turn-counter region (+120 bytes after GAME_TURN)
        # in all 4 Lafayette saves to identify the actual marker ID.
        GAME_TURN_MARKER = bytes([0x9d, 0x2c, 0xe6, 0xbd])
        saves = [
            ("exp01",  "saves/LafayetteExp1.Civ7Save",    1),
            ("auto35", "saves/AutoSave_01_0035.Civ7Save", 34),
            ("auto50", "saves/AutoSave_01_0050.Civ7Save", 49),
            ("auto60", "saves/AutoSave_01_0060.Civ7Save", 59),
        ]
        for label, path, expected in saves:
            data = load_save(path)
            mp = find_compressed_block(data)
            chunks, _ = read_chunks(data, mp)
            dec = decompress_game_state(chunks)
            gt_pos = dec.find(GAME_TURN_MARKER)
            target = gt_pos + 120  # confirmed offset: FXSBLKED array start
            print(f"\n--- {label} (expected turn ~{expected}) ---")
            print(f"  GAME_TURN at 0x{gt_pos:08x}")
            print(hex_dump(dec, gt_pos, 256))
            val = struct.unpack_from("<I", dec, target)[0]
            print(f"  Plain u32 at +120 (turn array start): {val}")

        # Also check ConfuciusAnt100 for cross-game validation
        print("\n--- ConfuciusAnt100 (expected Antiquity ~turn 100) ---")
        data = load_save("saves/ConfuciusAnt100.Civ7Save")
        mp = find_compressed_block(data)
        chunks, _ = read_chunks(data, mp)
        dec = decompress_game_state(chunks)
        gt_pos = dec.find(GAME_TURN_MARKER)
        if gt_pos >= 0:
            target = gt_pos + 120
            print(f"  GAME_TURN at 0x{gt_pos:08x}")
            print(hex_dump(dec, gt_pos, 256))
            val = struct.unpack_from("<I", dec, target)[0]
            print(f"  Plain u32 at +120: {val}")
        else:
            print("  GAME_TURN marker not found")

    elif len(sys.argv) == 2 and sys.argv[1] == "--cross":
        # Diff two decompressed game states byte-by-byte; find u32 LE values
        # that changed between Exp1 (expected ~turn 1) and autosave (turn 60)
        # Look for positions where one value is 1-10 and the other is 50-70.
        paths = ["saves/LafayetteExp1.Civ7Save", "saves/AutoSave_01_0060.Civ7Save"]
        decs = []
        for path in paths:
            data = load_save(path)
            mp = find_compressed_block(data)
            chunks, _ = read_chunks(data, mp)
            decs.append(decompress_game_state(chunks))

        print("Scanning for turn-like u32 changes (val_a in 1-10, val_b in 50-70)...")
        a, b = decs[0], decs[1]
        limit = min(len(a), len(b)) - 4
        found = []
        for i in range(0, limit, 4):
            va = struct.unpack_from("<I", a, i)[0]
            vb = struct.unpack_from("<I", b, i)[0]
            if va != vb and 1 <= va <= 10 and 50 <= vb <= 70:
                found.append((i, va, vb))
        print(f"Found {len(found)} candidates, showing exact-60 hits:")
        exact_60 = [(off, va, vb) for off, va, vb in found if vb == 60]
        print(f"  {len(exact_60)} positions where value changes to exactly 60:")
        for off, va, vb in exact_60:
            print(f"\n  === offset 0x{off:08x}: {va} → {vb} ===")
            # Wide context dump
            start = max(0, off - 32)
            for i in range(start, min(len(a), off + 32), 16):
                row_a = a[i:i+16]
                row_b = b[i:i+16]
                hex_a = " ".join(f"{x:02x}" for x in row_a)
                hex_b = " ".join(f"{x:02x}" for x in row_b)
                marker = " <<<" if i <= off < i+16 else ""
                print(f"  A {i:08x}: {hex_a}")
                if row_a != row_b:
                    print(f"  B {i:08x}: {hex_b}{marker}")
    else:
        path = sys.argv[1] if len(sys.argv) > 1 else "saves/LafayetteExp1.Civ7Save"
        analyze(path)
