// A fast drop-in for csv-reader 1.0.0: run(input) returns csv-reader's reading of {text, header},
// the value {columns, rows, errors}, for every input.
//
// The reading policy (make.fun's own, followed exactly):
//   - the text is read once, left to right; a U+FEFF at its very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled: "" inside it is
//     one quote, and each CRLF or lone CR inside it is read as LF; what follows the closing quote,
//     up to the next comma or line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed
//     or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with empty strings (short_row, with fields:
//     its field count) or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts
//     on, counting every LF, CRLF and lone CR inside quotes; row its record's index in rows, null
//     for the header.
//
// How it scans: where csv-reader steps one character at a time and builds each field a character
// at a time, this reader jumps between the special characters (comma, quote, LF, CR) with
// indexOf and takes each unbroken run of a field as one slice. A field is assembled from parts
// only when its own characters force it: doubled quotes or a CR inside a quoted field, a stray
// CR in an unquoted field, or junk after a closing quote. The answers are csv-reader's; only the
// scanning changed.

const COMMA = 0; // the field ended at a comma: the record goes on
const BREAK = 1; // the field ended at a line break: the record ends
const END = 2; // the field ended at the end of the text: the record ends

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text[0] === '\uFEFF') pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters the last unquoted
  // scan kept (the quote_junk test needs that count).
  let fv = '';
  let fe = END;
  let fa = 0;

  function fail(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The number of LFs in text[a, b).
  function countLf(a, b) {
    let n = 0;
    let i = text.indexOf('\n', a);
    while (i !== -1 && i < b) {
      n += 1;
      i = text.indexOf('\n', i + 1);
    }
    return n;
  }

  // Reads an unquoted field (or the junk after a closing quote) onto `head`: the field runs
  // from pos to the next comma or line break. Sets fv, fe and fa (the characters kept from the
  // text itself, head not counted) and advances pos and line past the field and its ending.
  function scanUnquoted(head) {
    const start = pos;
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = len;
    let end = text.indexOf(',', start);
    if (end === -1 || end > nl) end = nl;
    const atBreak = end === nl; // the field ends at a line break or at the text's end
    const seg = text.slice(start, end);
    const cr = seg.indexOf('\r');
    if (cr === -1) {
      fv = head + seg;
      fa = seg.length;
    } else if (cr === seg.length - 1 && atBreak && nl < len) {
      // The CR is the first half of the CRLF that ends the record: not part of the field.
      fv = head + seg.slice(0, cr);
      fa = cr;
      pos = nl + 1;
      line += 1;
      fe = BREAK;
      return;
    } else {
      // Stray CRs inside the field: dropped, one error each, the rest kept as it stands. A CR
      // as the very last character still belongs to a closing CRLF when one follows.
      const parts = [head];
      let kept = 0;
      let cur = 0;
      let i = cr;
      for (;;) {
        if (i === seg.length - 1 && atBreak && nl < len) {
          parts.push(seg.slice(cur, i));
          kept += i - cur;
          cur = seg.length;
          break;
        }
        parts.push(seg.slice(cur, i));
        kept += i - cur;
        fail('stray_cr');
        cur = i + 1;
        if (cur >= seg.length) break;
        i = seg.indexOf('\r', cur);
        if (i === -1) break;
      }
      if (cur < seg.length) {
        parts.push(seg.slice(cur));
        kept += seg.length - cur;
      }
      fv = parts.join('');
      fa = kept;
    }
    if (atBreak) {
      if (nl < len) {
        pos = nl + 1;
        line += 1;
        fe = BREAK;
      } else {
        pos = len;
        fe = END;
      }
    } else {
      pos = end + 1;
      fe = COMMA;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fv and fe.
  function scanQuoted() {
    const open = pos;
    // Find the closing quote: the next quote that is not doubled. Quotes pair off as they are
    // met, so the body between the opening quote and the close holds its quotes as "" pairs.
    let i = open + 1;
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) break;
      if (text[q + 1] === '"') {
        i = q + 2;
        continue;
      }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again
      // as unquoted. The search above touched neither pos nor line, so nothing needs undoing.
      pos = open + 1;
      fail('unterminated_quote');
      scanUnquoted('"');
      return;
    }
    const seg = text.slice(open + 1, close);
    if (seg.indexOf('\r') === -1) {
      // No CR to convert: the LFs inside are lines as they stand, and "" pairs are the only
      // editing the body can need.
      line += countLf(open + 1, close);
      fv = seg.indexOf('""') === -1 ? seg : seg.split('""').join('"');
    } else {
      // CRs inside quotes are read as LF (a CRLF as one LF): rebuild the body from parts,
      // counting the lone LFs in each kept run as lines and each CR as one more.
      const parts = [];
      let cur = 0;
      for (;;) {
        const r = seg.indexOf('\r', cur);
        const q = seg.indexOf('""', cur);
        if (r === -1 && q === -1) break;
        if (q === -1 || (r !== -1 && r < q)) {
          const run = seg.slice(cur, r);
          line += countLf(open + 1 + cur, open + 1 + r);
          parts.push(run, '\n');
          line += 1;
          cur = r + 1;
          if (seg[cur] === '\n') cur += 1; // the LF of a CRLF is spent with its CR
        } else {
          parts.push(seg.slice(cur, q), '"');
          line += countLf(open + 1 + cur, open + 1 + q);
          cur = q + 2;
        }
      }
      const tail = seg.slice(cur);
      line += countLf(open + 1 + cur, close);
      parts.push(tail);
      fv = parts.join('');
    }
    pos = close + 1;
    if (pos >= len) {
      fe = END;
      return;
    }
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      fe = COMMA;
      return;
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      fe = BREAK;
      return;
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      fe = BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line
    // break; that is quote_junk, recorded when the field ends, after any error inside the junk.
    const value = fv;
    scanUnquoted(value);
    if (fa > 0) fail('quote_junk');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text[pos] === '"';
      if (quoted) scanQuoted();
      else scanUnquoted('');
      fields.push(fv);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
