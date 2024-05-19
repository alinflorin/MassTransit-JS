import {ConsumeContext} from './consumeContext';
import EventEmitter from 'events';
import {deserialize, serialize} from 'class-transformer';
import {SendContext} from './sendContext';
import {ReceiveEndpoint} from './receiveEndpoint';
import { ConfirmChannel, ConsumeMessage } from 'amqplib';

export type MessageMap = Record<string, any>
export type MessageHandler<T extends MessageMap> = (message: ConsumeContext<T>) => void

export interface MessageDeserializer {
    dispatch(json: string, cm: ConsumeMessage, cc: ConfirmChannel): void
}

export interface MessageTypeDeserializer<T extends MessageMap> extends MessageDeserializer {
    on(handler: MessageHandler<T>): void

    off(handler: MessageHandler<T>): void
}

export class MessageTypeDeserializer<T extends MessageMap> implements MessageTypeDeserializer<T> {
    private readonly receiveEndpoint: ReceiveEndpoint;
    private _emitter = new EventEmitter();

    constructor(receiveEndpoint: ReceiveEndpoint) {
        this.receiveEndpoint = receiveEndpoint;

    }

    on(handler: MessageHandler<T>): void {
        this._emitter.on('message', handler);
    }

    off(handler: MessageHandler<T>): void {
        this._emitter.off('message', handler);
    }

    dispatch(json: string, cm: ConsumeMessage, cc: ConfirmChannel): void {

        let context = <ConsumeContext<T>>deserialize(ConsumeContext, json);

        context.receiveEndpoint = this.receiveEndpoint;
        context.confirmChannel = cc;
        context.originalMessage = cm;

        this._emitter.emit('message', context);
    }
}

export interface MessageSerializer {
    serialize<T extends MessageMap>(send: SendContext<T>): Buffer
}

export class JsonMessageSerializer implements MessageSerializer {

    serialize<T extends MessageMap>(send: SendContext<T>) {

        return Buffer.from(serialize(send));
    }

}

