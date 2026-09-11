/** Shared line wrapping for the on-page editor and exported text boxes. */
export function wrapEditorText(text: string, width: number, size: number, measure: (text: string, size: number) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let line = '';
    for (const character of paragraph) {
      while (line && measure(line + character, size) > Math.max(1, width)) {
        const space = line.lastIndexOf(' ');
        if (space > 0) { lines.push(line.slice(0, space + 1)); line = line.slice(space + 1); }
        else { lines.push(line); line = ''; }
      }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

export const textLineHeight = (size: number) => size * 1.2;
export const textBaseline = (size: number) => size * .95;
