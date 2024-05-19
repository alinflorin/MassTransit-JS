import { ConfirmChannel, ConsumeMessage } from "amqplib";
import { Bus } from "./bus";
import { deserialize } from "class-transformer";
import { ConsumeContext } from "./consumeContext";
import { MessageContext } from "./messageContext";
import { MessageMap } from "./serialization";
import { SendEndpointArguments, Transport } from "./transport";
import { ChannelContext } from "./channelContext";
import { MessageType } from "./messageType";
import {
  EndpointSettings,
  RabbitMqEndpointAddress,
  RabbitMqHostAddress,
} from "./RabbitMqEndpointAddress";
import { SendEndpoint } from "./sendEndpoint";
import {
  defaultReceiveEndpointOptions,
  ReceiveEndpointOptions,
} from "./receiveEndpoint";

/**
 * Configure the receive endpoint, including any message handlers
 */
export interface AsyncReceiveEndpointConfigurator {
  queueName: string;
  options: ReceiveEndpointOptions;

  handle<T extends MessageMap>(
    messageType: MessageType,
    listener: (message: ConsumeContext<T>) => Promise<void>
  ): this;
}

export interface AsyncReceiveEndpoint {
  hostAddress: RabbitMqHostAddress;
  address: RabbitMqEndpointAddress;

  sendEndpoint(args: SendEndpointArguments): SendEndpoint;
}

export class AsyncReceiveEndpoint
  extends Transport
  implements AsyncReceiveEndpointConfigurator, AsyncReceiveEndpoint
{
  queueName: string;
  options: ReceiveEndpointOptions;

  handle<T extends Record<string, any>>(
    messageType: MessageType,
    listener: (message: ConsumeContext<T>) => Promise<void>
  ): this {
    if (!messageType) throw new Error(`Invalid argument: messageType`);

    let typeName = messageType.toString();

    if (this._messageTypes.hasOwnProperty(typeName)) {
      this._messageTypes[typeName].on(listener);
    } else {
      const deserializer = new AsyncMessageTypeDeserializer<T>(this, listener);
      this._messageTypes[typeName] = deserializer;
      this.boundEvents.push(messageType);
    }

    return this;
  }

  private readonly _messageTypes: MessageMap;
  private readonly boundEvents: MessageType[] = [];

  constructor(
    bus: Bus,
    queueName: string,
    cb?: (cfg: AsyncReceiveEndpointConfigurator) => void,
    options: ReceiveEndpointOptions = defaultReceiveEndpointOptions
  ) {
    super(bus);

    this.queueName = queueName;
    this.options = options;
    this.hostAddress = bus.hostAddress;
    this._messageTypes = {};

    if (cb) cb(this);

    let settings: EndpointSettings = { name: queueName, ...options };

    this.address = new RabbitMqEndpointAddress(bus.hostAddress, settings);

    this.on("channel", (context) => this.onChannel(context));
  }

  emitMessage(msg: ConsumeMessage): void {
    this.emit("message", msg);
  }

  private async onChannel(context: ChannelContext): Promise<void> {
    const _this = this;

    let channel = context.channel;

    await this.configureTopology(channel);

    let consume = await channel.consume(
      this.queueName,
      async (msg: ConsumeMessage | null) => {
        if (msg === null) return;

        try {
          _this.emit("message", msg);

          let text = msg.content.toString();

          let context = deserialize(MessageContext, text);

          if (
            context &&
            context.messageType &&
            context.messageType.length > 0
          ) {
            let messageType = context.messageType[0];

            let deserializer = this._messageTypes[messageType];
            if (deserializer instanceof AsyncMessageTypeDeserializer) {
              await deserializer.handle(text, msg, channel);
            }
          }
          if (!this.options.disableAutoAck) {
            channel.ack(msg);
          }
        } catch (e) {
          if (!msg.properties.headers) {
            msg.properties.headers = {};
          }
          let currentRetries = msg.properties.headers!["x-retries"]
            ? +msg.properties.headers!["x-retries"]
            : 0;
          let newRetries = currentRetries + 1;
          msg.properties.headers["x-retries"] = newRetries;

          if (!this.options.disableAutoAck) {
            channel.reject(msg, false);
            if (
              !this.options.disableRepublishOnError &&
              (!this.options.maxRetries ||
                (this.options.maxRetries &&
                  newRetries < this.options.maxRetries!))
            ) {
              channel.publish(
                msg.fields.exchange,
                msg.fields.routingKey,
                msg.content,
                {
                  contentType: msg.properties.contentType,
                  deliveryMode: msg.properties.deliveryMode,
                  contentEncoding: msg.properties.contentEncoding,
                  appId: msg.properties.appId,
                  correlationId: msg.properties.correlationId,
                  expiration: msg.properties.expiration,
                  headers: msg.properties.headers,
                  messageId: msg.properties.messageId,
                  priority: msg.properties.priority,
                  replyTo: msg.properties.replyTo,
                  timestamp: msg.properties.timestamp,
                  type: msg.properties.type,
                  userId: msg.properties.userId,
                }
              );
            }
          }
        }
      },
      this.options
    );

    this.options.consumerTag = consume.consumerTag;

    console.log(
      "Receive endpoint started:",
      this.queueName,
      "ConsumerTag:",
      consume.consumerTag
    );
  }

  private async configureTopology(channel: ConfirmChannel) {
    await channel.prefetch(
      this.options.prefetchCount!,
      this.options.globalPrefetch
    );

    await channel.assertExchange(this.queueName, "fanout", this.options);
    let queue = await channel.assertQueue(this.queueName, this.options);

    await channel.bindQueue(this.queueName, this.queueName, "");

    for (const messageType of this.boundEvents) {
      await channel.assertExchange(
        messageType.toExchange(),
        "fanout",
        this.options
      );
      await channel.bindExchange(this.queueName, messageType.toExchange(), "");
    }

    console.log(
      "Queue:",
      queue.queue,
      "MessageCount:",
      queue.messageCount,
      "ConsumerCount:",
      queue.consumerCount
    );
  }
}

export class AsyncMessageTypeDeserializer<T extends MessageMap> {
  private readonly receiveEndpoint: AsyncReceiveEndpoint;
  private readonly handler: (context: ConsumeContext<T>) => Promise<void>;

  constructor(
    receiveEndpoint: AsyncReceiveEndpoint,
    handler: (context: ConsumeContext<T>) => Promise<void>
  ) {
    this.receiveEndpoint = receiveEndpoint;
    this.handler = handler;
  }

  handle(json: string, om: ConsumeMessage, cc: ConfirmChannel): Promise<void> {
    let context = <ConsumeContext<T>>deserialize(ConsumeContext, json);

    context.receiveEndpoint = this.receiveEndpoint;
    context.originalMessage = om;
    context.confirmChannel = cc;

    return this.handler(context);
  }
}
