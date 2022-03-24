import { chunk } from "lodash"
import { store } from "../redux/index"
import { createInternalJob } from "../utils/jobs/manager"
import { createJobV2FromInternalJob } from "../redux/actions/internal"

const pageGenChunkSize =
  Number(process.env.GATSBY_PARALLEL_QUERY_CHUNK_SIZE) || 50

interface IQueryIds {
  pageQueryIds: Array<{ path: string }>
}

export function runPageGenerationJobs(queryIds: IQueryIds): void {
  const pageChunks = chunk(queryIds?.pageQueryIds, pageGenChunkSize)

  pageChunks.forEach(items => {
    const job = createInternalJob(
      {
        name: `GENERATE_PAGE`,
        args: {
          paths: items?.map(item => item?.path),
        },
        inputPaths: [],
        outputDir: __dirname,
        plugin: {
          name: `gatsby`,
          version: `4.10.1`,
          resolve: __dirname,
        },
      },
      {
        name: `gatsby`,
        version: `4.10.1`,
        resolve: __dirname,
      }
    )

    createJobV2FromInternalJob(job)(store.dispatch, store.getState)
  })
}
