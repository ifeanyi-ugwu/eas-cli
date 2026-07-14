import gql from 'graphql-tag';

import { ExpoGraphqlClient } from '../../commandUtils/context/contextUtils/createGraphqlClient';
import { withErrorHandlingAsync } from '../client';
import {
  TurtleSshSessionForResourceQuery,
  TurtleSshSessionForResourceQueryVariables,
} from '../generated';

export type TurtleSshSession = NonNullable<
  TurtleSshSessionForResourceQuery['turtleSshSessions']['forResourceId']
>;

export const TurtleSshSessionQuery = {
  async forResourceIdAsync(
    graphqlClient: ExpoGraphqlClient,
    id: string
  ): Promise<TurtleSshSession | null> {
    const data = await withErrorHandlingAsync(
      graphqlClient
        .query<TurtleSshSessionForResourceQuery, TurtleSshSessionForResourceQueryVariables>(
          gql`
            query TurtleSshSessionForResource($id: ID!) {
              turtleSshSessions {
                forResourceId(id: $id) {
                  id
                  closedAt
                  connectionConfig {
                    connectionHost
                    secret
                  }
                }
              }
            }
          `,
          { id },
          { requestPolicy: 'network-only' }
        )
        .toPromise()
    );
    return data.turtleSshSessions.forResourceId ?? null;
  },
};
