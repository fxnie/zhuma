import { test, expect } from './replay.mjs';

function listedTask(state, id, projectId, title) {
  return {
    ...structuredClone(state.tasks[0]),
    id,
    projectId,
    title,
    participantIds: ['chen'],
    ownerId: 'chen',
  };
}

test('任务清单筛选中强调计数与项目条件，清除后恢复全部', async ({ page, replay }) => {
  replay.state.projects = [
    { id: 'nav', name: '导航条', description: '' },
    { id: 'qa', name: 'QA评审项目-1428', description: '' },
  ];
  replay.state.tasks = [
    listedTask(replay.state, 'fold', 'nav', '选中某条提示后，折叠的导航条会停在这一条上'),
    listedTask(replay.state, 'bar', 'nav', '导航条'),
    listedTask(replay.state, 'review', 'qa', '评审任务：验证创建任务表单与提示是否到位'),
  ];
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  const summary = page.locator('.zm-task-filter-summary');
  const project = page.getByLabel('筛选项目', { exact: true });
  const clear = page.getByRole('button', { name: '清除筛选', exact: true });
  await expect(summary).toContainText('3 / 3');
  await expect(summary).not.toHaveClass(/is-filtering/);
  await expect(clear).toHaveCount(0);
  await expect(page.locator('.zm-task-row')).toHaveCount(3);

  await project.click();
  await page.getByRole('option', { name: '导航条', exact: true }).click();
  await expect(project).toHaveClass(/is-filtering/);
  await expect(project).toContainText('导航条');
  await expect(page.getByLabel('筛选参与者', { exact: true })).not.toHaveClass(/is-filtering/);
  await expect(page.getByLabel('筛选阶段', { exact: true })).not.toHaveClass(/is-filtering/);
  await expect(page.getByLabel('搜索任务', { exact: true })).not.toHaveClass(/is-filtering/);
  await expect(summary).toHaveClass(/is-filtering/);
  await expect(summary.getByText('已筛选', { exact: true })).toBeVisible();
  await expect(summary).toContainText('2 / 3');
  await expect(page.locator('.zm-task-row')).toHaveCount(2);
  await expect(clear).toBeVisible();
  const contrast = await page.evaluate(() => {
    const style = (element) => {
      const computed = getComputedStyle(element);
      return {
        background: computed.backgroundColor,
        color: computed.color,
        weight: computed.fontWeight,
      };
    };
    const active = document.querySelector('.zm-task-filters .zm-single-select.is-filtering');
    const idle = [...document.querySelectorAll('.zm-task-filters .zm-single-select')].find(
      (element) => !element.classList.contains('is-filtering'),
    );
    return {
      active: style(active),
      idle: style(idle),
      count: style(document.querySelector('.zm-filter-count')),
      flag: style(document.querySelector('.zm-filter-flag')),
    };
  });
  expect(contrast.active.background).not.toBe(contrast.idle.background);
  expect(contrast.active.color).not.toBe(contrast.idle.color);
  expect(Number(contrast.active.weight)).toBeGreaterThanOrEqual(600);
  expect(contrast.flag.background).toBe(contrast.active.background);
  expect(contrast.flag.color).toBe(contrast.active.color);
  expect(contrast.count.background).not.toBe(contrast.idle.background);
  expect(Number(contrast.count.weight)).toBeGreaterThanOrEqual(600);

  await clear.click();
  await expect(project).toContainText('所有项目');
  await expect(project).not.toHaveClass(/is-filtering/);
  await expect(summary).not.toHaveClass(/is-filtering/);
  await expect(summary.getByText('已筛选', { exact: true })).toHaveCount(0);
  await expect(summary).toContainText('3 / 3');
  await expect(page.locator('.zm-task-row')).toHaveCount(3);
  await expect(clear).toHaveCount(0);
  expect(replay.requests.filter((request) => request.endpoint !== 'snapshot')).toHaveLength(0);
});
