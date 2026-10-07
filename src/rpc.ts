/**
 * RPC contract between the server plugin (which owns credentials and network
 * access) and the TUI plugin (which renders the status bar).
 *
 * Schemas are intentionally permissive — they validate the request/response
 * envelope and let the snapshot payload pass through untouched.
 */

import { Rpc } from "@opencode/plugin/rpc";

const objectSchema = { type: "object", additionalProperties: true } as const;

export const ProviderUsage = Rpc.define({
	id: "isword.provider-usage",
	methods: {
		/** Return the latest snapshot without hitting the network. */
		get: {
			input: objectSchema,
			output: objectSchema,
		},
		/** Force a refresh. `all` also refreshes providers other than the active one. */
		refresh: {
			input: objectSchema,
			output: objectSchema,
		},
	},
	events: {
		/** Emitted after every refresh round with the new snapshot. */
		updated: {
			schema: objectSchema,
		},
	},
});
