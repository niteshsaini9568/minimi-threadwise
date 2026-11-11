import { readFile, writeFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { runAgent } from '../src/agent.js';

if (!process.env.OPENAI_API_KEY?.trim()) {
  console.error('Live evaluation requires OPENAI_API_KEY in .env. No calls were made. Use npm test for offline checks.');
  process.exitCode = 1;
} else {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1, timeout: 120_000 });
  const sample = JSON.parse(await readFile(new URL('../fixtures/sample-history.json', import.meta.url), 'utf8'));
  const cases = JSON.parse(await readFile(new URL('../fixtures/eval-cases.json', import.meta.url), 'utf8'));
  const history = sample.threads.flatMap((thread, index) => thread.turns.map((turn, i) => ({ ...turn,
    id: `fixture-${index}-${i}`, thread_id: `fixture-${index}`, thread_title: thread.title,
    completed_at: turn.created_at, status: 'completed', evidence: { imported: true, sources: [] },
  })));
  const results = [];
  const filename = `eval-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  for (const item of cases) {
    console.log(`Running: ${item.name}`);
    const now = new Date().toISOString();
    try {
      const answer = await runAgent({ client, model: process.env.OPENAI_MODEL || 'gpt-6.1-sol', memoryModel: process.env.MEMORY_MODEL || 'gpt-6-luna',
        history: item.history === false ? [] : history, question: item.question, threadId: 'evaluation', now,
        timezone: 'Asia/Kolkata', signal: AbortSignal.timeout(120_000) });
      results.push({ ...item, checked_at: now, ...answer, manual_grade: null });
      console.log(`  ${answer.total_ms} ms, ${answer.sources.length} sources, ${answer.usage?.total_tokens ?? '?'} tokens`);
    } catch (error) {
      results.push({ ...item, checked_at: now, error: { name: error.name, status: error.status ?? null }, manual_grade: null });
      console.error(`  Failed: ${error.name}${error.status ? ` (${error.status})` : ''}`);
      process.exitCode = 1;
    }
    await writeFile(filename, JSON.stringify({ note: 'Live output; manually grade against acceptance criteria. No automatic factual-accuracy score.', results }, null, 2));
  }
  console.log(`Saved ${filename}. Review claim support and effective dates before assigning grades.`);
}
