import {
  describeJobRunnerConformance,
  type ScheduledRuns,
} from "./conformance.js";
import { openJobRunner } from "./job-runner.js";

describeJobRunnerConformance({
  adapter: "pg-boss",
  open: (database, jobs, role, onError) =>
    openJobRunner(
      {
        db: database.runtime.db,
        jobs,
        onError,
        intervals: { pollingSeconds: 0.5, superviseSeconds: 1, cronSeconds: 1 },
      },
      role,
    ),
  async readStoredJobData(database, name, id) {
    const result = await database.admin.query<{ data: unknown }>(
      "SELECT data FROM pgboss.job WHERE name = $1 AND id = $2",
      [name, id],
    );
    return result.rows[0]?.data;
  },
  async rewriteStoredJobData(database, name, id, data) {
    await database.admin.query(
      "UPDATE pgboss.job SET data = $3 WHERE name = $1 AND id = $2",
      [name, id, JSON.stringify(data)],
    );
  },
  async readJobs(database, name) {
    const result = await database.admin.query<{
      id: string;
      state: string;
      output: unknown;
      sourceId: string | null;
    }>(
      `SELECT id, state, output, source_id AS "sourceId"
       FROM pgboss.job WHERE name = $1`,
      [name],
    );
    return result.rows;
  },
  async readScheduledRuns(database, name) {
    const result = await database.admin.query<ScheduledRuns>(
      `SELECT
         COALESCE((SELECT json_agg(json_build_object('id', id, 'state', state, 'output', output, 'sourceId', source_id))
                   FROM pgboss.job WHERE name = $1), '[]') AS jobs,
         COALESCE((SELECT json_agg(json_build_object('slot', singleton_on, 'state', state))
                   FROM pgboss.job WHERE name = '__pgboss__send-it' AND data->>'name' = $1), '[]') AS ticks`,
      [name],
    );
    return result.rows[0] ?? { jobs: [], ticks: [] };
  },
  async abandonAttempt(database, name, id) {
    await database.admin.query(
      "UPDATE pgboss.job SET state = 'active', started_on = now() WHERE name = $1 AND id = $2",
      [name, id],
    );
  },
  async passRetention(database, name, id) {
    await database.admin.query(
      "UPDATE pgboss.job SET keep_until = now() - interval '1 second' WHERE name = $1 AND id = $2",
      [name, id],
    );
  },
});
