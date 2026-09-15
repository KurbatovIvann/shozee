import { describeJobRunnerConformance } from "./conformance.js";
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
      createdOn: Date;
    }>(
      `SELECT id, state, output, source_id AS "sourceId", created_on AS "createdOn"
       FROM pgboss.job WHERE name = $1`,
      [name],
    );
    return result.rows;
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
