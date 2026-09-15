import { describeJobRunnerConformance } from "./conformance.js";
import { openJobRunner } from "./job-runner.js";

describeJobRunnerConformance({
  adapter: "pg-boss",
  open: (database, jobs, role) =>
    openJobRunner(
      {
        db: database.runtime.db,
        jobs,
        onError: (error) => {
          throw error;
        },
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
});
