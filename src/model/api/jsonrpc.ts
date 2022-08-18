import {
    ContentDescriptorObject,
    JSONSchemaObject,
    MethodObject,
    OpenrpcDocument
} from "@open-rpc/meta-schema";
import { SchemaObject } from "openapi-directory";
import { HtkResponse, Html, HttpExchange } from "../../types";
import { ErrorLike, isErrorLike } from "../../util/error";
import { fromMarkdown } from "../markdown";
import {
    ApiExchange,
    ApiOperation,
    ApiParameter,
    ApiRequest,
    ApiResponse,
    ApiService
} from "./api-interfaces";

export type OpenRpcDocument = OpenrpcDocument;

export interface OpenRpcMetadata {
    type: 'openrpc';
    spec: OpenRpcDocument;
    serverMatcher: RegExp;
    requestMatchers: { [methodName: string] : MethodObject }; // JSON-RPC method name to method
}

export async function parseRpcApiExchange(
    api: OpenRpcMetadata,
    exchange: HttpExchange
): Promise<JsonRpcApiExchange> {
    try {
        const body = await exchange.request.body.decodedPromise;

        if (!body?.length) throw new Error(`No JSON-RPC request body`);

        let parsedBody: any;
        let methodName: string;
        try {
            parsedBody = JSON.parse(body?.toString());
            if (parsedBody.jsonrpc !== '2.0') throw new Error(
                `JSON-RPC request body had bad 'jsonrpc' field: ${parsedBody.jsonrpc}`
            );

            methodName = parsedBody.method;
        } catch (e) {
            console.warn(e);
            throw new Error('Could not parse JSON-RPC request body');
        }

        const methodSpec = api.requestMatchers[methodName];
        if (!methodSpec) throw new Error(`Unrecognized JSON-RPC method name: ${methodName}`);

        const operation = {
            methodSpec,
            parsedBody
        };

        return new JsonRpcApiExchange(api, exchange, operation);
    } catch (error) {
        return new JsonRpcApiExchange(api, exchange, error as ErrorLike);
    }
}

interface MatchedOperation {
    methodSpec: MethodObject;
    parsedBody: any;
}

export class JsonRpcApiExchange implements ApiExchange {

    constructor(
        private _api: OpenRpcMetadata,
        private _exchange: HttpExchange,
        private _rpcMethod: MatchedOperation | ErrorLike
    ) {
        this.service = new JsonRpcApiService(_api);

        if (isErrorLike(_rpcMethod)) {
            this.operation = {
                name: 'Unrecognized request to JSON-RPC API',
                warnings: [_rpcMethod.message ?? _rpcMethod.toString()]
            };
            this.request = { parameters: [] };
        } else {
            this.operation = new JsonRpcApiOperation(
                _rpcMethod,
                _api.spec.externalDocs?.['x-method-base-url'] // Custom extension
            );
            this.request = new JsonRpcApiRequest(_rpcMethod, _exchange);
        }
    }

    readonly service: ApiService;
    readonly operation: ApiOperation;
    readonly request: ApiRequest;
    response: ApiResponse | undefined;

    updateWithResponse(response: HtkResponse | "aborted" | undefined): void {
        if (
            response === 'aborted' ||
            response === undefined ||
            isErrorLike(this._rpcMethod)
        ) return;

        this.response = new JsonRpcApiResponse(this._rpcMethod);
    }

    matchedOperation(): boolean {
        return !!this._rpcMethod;
    }

}

export class JsonRpcApiService implements ApiService {

    constructor(api: OpenRpcMetadata) {
        this.name = api.spec.info.title;
        this.logoUrl = api.spec.info['x-logo']?.url;
        this.description = fromMarkdown(api.spec.info.description);
        this.docsUrl = api.spec.externalDocs?.url;
    }

    readonly name: string;
    readonly logoUrl?: string | undefined;
    readonly description?: Html | undefined;
    readonly docsUrl?: string | undefined;

}

export class JsonRpcApiOperation implements ApiOperation {

    constructor(
        rpcMethod: MatchedOperation,
        methodDocsBaseUrl: string | undefined
    ) {
        const { methodSpec } = rpcMethod;

        this.name = methodSpec.name;
        this.description = fromMarkdown([
            methodSpec.summary,
            methodSpec.description
        ].filter(x => !!x).join('\n\n'));
        this.docsUrl = methodSpec.externalDocs?.url
            ?? (methodDocsBaseUrl
                ? methodDocsBaseUrl + methodSpec.name.toLowerCase()
                : undefined
            );

        if (methodSpec.deprecated) {
            this.warnings.push(`The '${this.name}' method is deprecated.`);
        }
    }

    name: string;
    description?: Html | undefined;
    docsUrl?: string | undefined;
    warnings: string[] = [];

}

export class JsonRpcApiRequest implements ApiRequest {

    constructor(rpcMethod: MatchedOperation, exchange: HttpExchange) {
        const { methodSpec, parsedBody } = rpcMethod;

        this.parameters = (methodSpec.params as ContentDescriptorObject[])
            .map((param: ContentDescriptorObject, i: number) => ({
                name: param.name,
                description: fromMarkdown([
                    param.summary,
                    param.description,
                    (param.schema as JSONSchemaObject)?.title
                ].filter(x => !!x).join('\n\n')),
                in: 'body',
                required: !!param.required,
                deprecated: !!param.deprecated,
                value: parsedBody.params[i],
                defaultValue: (param.schema as JSONSchemaObject).default,
                warnings: [
                    ...(param.deprecated ? [`The '${param.name}' parameter is deprecated.`] : []),
                    ...(param.required &&
                        parsedBody.params[i] === undefined &&
                        (param.schema as JSONSchemaObject).default === undefined
                        ? [`The '${param.name}' parameter is required.`]
                        : []
                    )
                ]
            }));
    }

    parameters: ApiParameter[];

}

export class JsonRpcApiResponse implements ApiResponse {

    constructor(rpcMethod: MatchedOperation) {
        const resultSpec = rpcMethod.methodSpec.result as ContentDescriptorObject;

        this.description = fromMarkdown(resultSpec.description);
        this.bodySchema = resultSpec.schema as SchemaObject;
    }

    description?: Html;
    bodySchema?: SchemaObject;

}