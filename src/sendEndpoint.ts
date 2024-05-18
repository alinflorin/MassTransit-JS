import {SendContext} from './sendContext';
import {Transport} from './transport';
import {MessageMap} from './serialization';
import { MessageType } from './messageType';

export interface SendEndpoint {
    send<T extends MessageMap>(message: T, cb?: (send: SendContext<T>) => void): Promise<void>
}

export class SendEndpoint implements SendEndpoint {
    private transport: Transport;
    private readonly exchange: string;
    private readonly routingKey: string;
    private readonly mt: MessageType | undefined;

    constructor(transport: Transport, mt: MessageType | undefined = undefined, exchange?: string, routingKey?: string) {
        this.transport = transport;
        this.mt = mt;
        this.exchange = exchange ?? '';
        this.routingKey = routingKey ?? '';
    }

    async send<T extends object>(message: T, headers: object = {}, cb?: (send: SendContext<T>) => void) {
        let send = new SendContext<T>(message);
        if (this.mt) {
            send.messageType = this.mt.toMessageType();
        }
        send.sentTime = new Date().toISOString();
        send.headers = headers;
        if (cb) {
            cb(send);
        }
        await this.transport.send(this.exchange, this.routingKey, send);
    }
}


