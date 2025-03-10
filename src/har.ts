import {Entry, Har} from "har-format";
import http, {AuthMethod, RefinedParams, RefinedResponse, ResponseType} from 'k6/http';
import {SharedArray} from "k6/data";
import {check} from "k6";

export interface HARDocumentRequestOptions {

    /**
     * This is a list of allowed domains names which should be requested.
     *
     * An unfiltered HAR of a typical site will usually contain tons of requests
     * to 3rd party sites (tracking, yay), which you probably don't want to hit
     * with your load test.
     *
     * The domain of your initial document request will be automatically allowed.
     */
    allowedDomains?: string[];

    /**
     * Use this field to also execute unsafe requests (POST and other) that are
     * recorded in the HAR file.
     *
     * Note that this is a potentially very stupid idea. Only do this if you
     * know what you're doing.
     */
    executeUnsafeRequests?: false;

    /**
     * Authentication method; will be passed through to request options.
     */
    auth?: AuthMethod;

    checkResponseStatus?: boolean;
}

export interface HARDocumentResponseCollection {
    /**
     * The response to the main document request.
     */
    documentResponse: RefinedResponse<ResponseType>;

    /**
     * The responses for all resources (stylesheets, scripts, and others).
     */
    resourceResponses: RefinedResponse<ResponseType>[];
}

export default class HARDocument {

    private readonly options: HARDocumentRequestOptions;
    private readonly entries: Entry[];
    private readonly allowedURLPrefixes: string[];

    /**
     * Creates a new document from an HAR file referenced by filename.
     *
     * The HAR file will be loaded into a shared memory segment that is shared
     * across all VUs.
     *
     * @param filename Filename of an HAR file to load
     * @param opts Request options that should be passed to the HARDocument constructor
     */
    public static fromFile(filename: string, opts: HARDocumentRequestOptions): HARDocument {
        // Use SharedArray so that the HAR is shared across all VUs (these files might get BIG)
        const entries = new SharedArray(filename, () => {
            const harFile = open(filename);
            const har = JSON.parse(harFile) as Har;
            return har.log.entries;
        });

        return new HARDocument(entries, opts);
    }

    /**
     * @param entries List of entries from an HAR file. Must contain (at least) one entry with '_resourceType == "document"'
     * @param opts Request options. See documentation of HARDocumentRequestOptions for details
     */
    public constructor(entries: Entry[], opts: HARDocumentRequestOptions) {
        this.options = opts;
        this.entries = entries;
        this.allowedURLPrefixes = this.determineAllowedURLPrefixes();
    }

    private determineAllowedURLPrefixes() {
        const {documentEntry} = this;
        const urlFromSite = documentEntry.request.url;
        const domain = urlFromSite.replace(/^https?:\/\//, "").split("/")[0];

        return [domain, ...(this.options.allowedDomains || [])]
    }

    private get documentEntry(): Entry {
        const docRequest = this.entries.find(e => e._resourceType === "document");
        if (!docRequest) {
            throw new Error("HAR did not contain request with '_resourceType == \"document\"'");
        }

        return docRequest;
    }

    private resourceEntries(pageRef: string): Entry[] {
        const {allowedURLPrefixes} = this;
        const resourceEntries = this.entries.filter(e => e.pageref === pageRef && e._resourceType !== "document")
        const safeResourceEntries = resourceEntries.filter(e => e.request.method.toLowerCase() === "get");

        return safeResourceEntries.filter(e => {
            // Note: We can't use url.parse here, because this is k6's own runtime, not Node.js
            const url = e.request.url.replace(/^https?:\/\//, "");
            return allowedURLPrefixes.some(pref => url.startsWith(pref));
        });
    }

    private get requestParams(): RefinedParams<ResponseType> {
        const {
            auth
        } = this.options;

        return {
            auth,
        };
    }

    /**
     * Executes the document request and all subsequent resource requests.
     *
     * The document request will be executed on its own, with all subsequent
     * requests being executed as a batch request [1].
     *
     * [1]: https://grafana.com/docs/k6/latest/javascript-api/k6-http/batch/
     */
    public executeRequest(): HARDocumentResponseCollection {
        const {documentEntry, requestParams} = this;
        const resourceType = documentEntry._resourceType ?? "unknown";
        const expectedResponseStatus = documentEntry.response.status;

        const documentResponse = http.get(documentEntry.request.url, {
            ...requestParams,
            tags: {
                ...requestParams.tags,
                resource_type: resourceType,
            },
        });

        if (this.options.checkResponseStatus) {
            check(documentResponse, {
                [`status is ${expectedResponseStatus}`]: r => r.status === expectedResponseStatus,
            });
        }

        const resourceEntries = this.resourceEntries(documentEntry.pageref!);
        const resourceResponses = http.batch(resourceEntries.map(e => {
            return [
                e.request.method,
                e.request.url,
                null,
                {
                    ...requestParams,
                    tags: {
                        ...requestParams.tags,
                        resource_type: e._resourceType ?? "unknown",
                    }
                }
            ]
        }));

        return {documentResponse, resourceResponses};
    }

}