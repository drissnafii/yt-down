import { expect, test } from 'bun:test';
import { TaskQueue } from '../extension/src/queue.ts';

test('runs two jobs, queues the third and releases slots only when a child ends', () => {
  const started: string[] = [];
  const done = new Map<string, () => void>();
  const queue = new TaskQueue<string>(2, (job, finish) => { started.push(job); done.set(job, finish); });
  for (const job of ['a', 'b', 'c']) queue.add(job, job);
  expect(started).toEqual(['a', 'b']);
  expect(queue.active).toBe(2);
  expect(queue.queued).toBe(1);
  done.get('a')!();
  expect(started).toEqual(['a', 'b', 'c']);
  done.get('a')!();
  expect(queue.active).toBe(2);
});

test('serializes conflicting output keys while allowing unrelated jobs through', () => {
  const started: string[] = [];
  const done = new Map<string, () => void>();
  const queue = new TaskQueue<string>(3, (job, finish) => { started.push(job); done.set(job, finish); });
  queue.add('first', 'same-video');
  queue.add('other-quality', 'same-video');
  queue.add('unrelated', 'other-video');
  expect(started).toEqual(['first', 'unrelated']);
  done.get('first')!();
  expect(started).toEqual(['first', 'unrelated', 'other-quality']);
});

test('queued cancellation, changing limits and stopping do not start unwanted jobs', () => {
  const started: string[] = [];
  const done = new Map<string, () => void>();
  const queue = new TaskQueue<string>(1, (job, finish) => { started.push(job); done.set(job, finish); });
  for (const job of ['a', 'b', 'c', 'd']) queue.add(job, job);
  expect(queue.remove('b')).toBe(true);
  expect(queue.remove('a')).toBe(false);
  queue.setLimit(2);
  expect(started).toEqual(['a', 'c']);
  queue.setLimit(1);
  done.get('a')!();
  expect(started).toEqual(['a', 'c']);
  queue.stop();
  done.get('c')!();
  queue.add('e', 'e');
  expect(started).toEqual(['a', 'c']);
});
