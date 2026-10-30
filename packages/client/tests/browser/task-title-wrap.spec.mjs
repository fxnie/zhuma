import { test, expect } from './replay.mjs';

// The reported list title, plus a repeated clause and one Latin word.
// Kept under the 160-character task title limit, and long enough to wrap in the list column.
const title =
  '选中某条提示后，折叠的导航条会停在这一条上，不再留在整段历史的中部。' +
  '不再留在整段历史的中部，'.repeat(6) +
  'Keep History.';

test('任务清单长标题在标点或词边界换行，不把词从中间断开', async ({ page, replay }) => {
  replay.state.tasks[0].title = title;
  // Around the review window: the title column wraps, while each clause still fits.
  await page.setViewportSize({ width: 820, height: 800 });
  await page.goto('/');
  const strong = page.locator('.zm-task-row strong');
  await expect(strong).toHaveText(title);
  const info = await strong.evaluate((el) => {
    const node = [...el.childNodes].find((child) => child.nodeType === Node.TEXT_NODE);
    const text = node?.textContent ?? '';
    const range = document.createRange();
    const lines = [];
    let top = null;
    let current = '';
    for (let index = 0; index < text.length; index += 1) {
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0) continue;
      if (top === null || Math.abs(rect.top - top) > 1) {
        if (current) lines.push(current);
        current = text[index];
        top = rect.top;
      } else current += text[index];
    }
    if (current) lines.push(current);
    const style = getComputedStyle(el);
    const cell = el.parentElement;
    const measure = (sample) => {
      const probe = document.createElement('span');
      probe.textContent = sample;
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font}`;
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };
    const clauses = text.split(/(?<=[，。、；：,.\s])/u).filter(Boolean);
    return {
      lines,
      wordBreak: style.wordBreak,
      overflowWrap: style.overflowWrap,
      overflows: cell.scrollWidth > cell.clientWidth + 1,
      textWiderThanCell: measure(text) > cell.clientWidth + 1,
      clausesFit: clauses.every((clause) => measure(clause) <= cell.clientWidth + 1),
    };
  });

  expect(info.wordBreak).toBe('keep-all');
  expect(info.overflowWrap).toBe('break-word');
  expect(info.overflows).toBe(false);
  expect(info.lines.join('')).toBe(title);
  expect(title.length).toBeLessThanOrEqual(160);
  // Clauses fit, so the title must wrap on punctuation or spaces instead of inside 历史 / History.
  expect(info.clausesFit).toBe(true);
  expect(info.textWiderThanCell).toBe(true);
  expect(info.lines.length).toBeGreaterThan(1);
  expect(info.lines.join('\n')).not.toMatch(/历\n史|中\n部|Histo\nry/);
  for (const line of info.lines.slice(0, -1)) expect(line).toMatch(/[，。、；：,.\s]$/u);
  expect(info.lines.some((line) => line.includes('历史'))).toBe(true);
  expect(info.lines.some((line) => line.includes('History'))).toBe(true);
});
