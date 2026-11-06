/** Index of the closing quote of the JSON string in progress at `from`, or -1/-2 when the chunk ends inside it unescaped/escaped. */
export function plainStringEnd(buf, from) {
  let q = buf.indexOf(0x22, from);
  while (q !== -1) {
    let k = q - 1;
    while (k >= from && buf[k] === 0x5c) k--;
    if ((q - 1 - k) % 2 === 0) return q;
    q = buf.indexOf(0x22, q + 1);
  }
  let k = buf.length - 1;
  while (k >= from && buf[k] === 0x5c) k--;
  return (buf.length - 1 - k) % 2 === 0 ? -1 : -2;
}
