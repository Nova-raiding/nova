/** Read an untrusted HTTP response without allowing an unbounded body allocation. */
export declare function readBoundedResponseText(response: Response, maxBytes: number, label?: string): Promise<string>;
//# sourceMappingURL=bounded-response.d.ts.map