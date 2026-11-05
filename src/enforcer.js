// Makes the outcome mandatory: when an agent owes one, log them out of their 3CX
// queues; log them back in once every pending call has an outcome.
// Only agents who were logged in to queues are touched, and only GETUS restores them.
export function createEnforcer({ config, repo, pbx, onChange, log }) {
  const chains = new Map();
  const serial = (ext, fn) => {
    const next = (chains.get(ext) || Promise.resolve()).catch(() => {}).then(fn);
    chains.set(ext, next);
    return next;
  };
  const hasPending = async (ext) => (await repo.callsFor(ext, 'pending')).length > 0;
  const isHeld = async (ext) => !!(await repo.getAgent(ext))?.held;

  function hold(ext) {
    if (!config.enforce) return Promise.resolve();
    return serial(ext, async () => {
      if ((await isHeld(ext)) || !(await hasPending(ext))) return;
      const status = await pbx.getQueueStatus(ext);
      if (status !== 'LoggedIn') {
        log.info(`[enforce] ${ext} queue status is ${status ?? 'unknown'}; not pausing`);
        return;
      }
      await pbx.setQueueStatus(ext, 'LoggedOut');
      await repo.setHeld(ext, true);
      log.info(`[enforce] ${ext} logged out of queues until the outcome is saved`);
      onChange(ext);
    });
  }

  function release(ext, { force = false } = {}) {
    return serial(ext, async () => {
      if (!(await isHeld(ext))) return;
      if (!force && (await hasPending(ext))) return;
      await pbx.setQueueStatus(ext, 'LoggedIn');
      await repo.setHeld(ext, false);
      log.info(`[enforce] ${ext} logged back in to queues${force ? ' (supervisor release)' : ''}`);
      onChange(ext);
    });
  }

  // Agents can log themselves back in from the 3CX app. Put them back out while they
  // still owe an outcome.
  async function guard() {
    for (const agent of await repo.heldAgents()) {
      const ext = agent.extension;
      try {
        if (!(await hasPending(ext))) { await release(ext); continue; }
        await serial(ext, async () => {
          if ((await pbx.getQueueStatus(ext)) === 'LoggedIn') {
            await pbx.setQueueStatus(ext, 'LoggedOut');
            log.warn(`[enforce] ${ext} logged back in before saving an outcome; logged out again`);
          }
        });
      } catch (err) {
        log.error(`[enforce] guard check for ${ext} failed:`, err.message);
      }
    }
  }

  if (config.enforce) setInterval(() => guard().catch((err) => log.error('[enforce] guard failed:', err.message)), config.guardIntervalMs).unref();

  return { hold, release, guard };
}
