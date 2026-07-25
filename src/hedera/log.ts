import {
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import { hashscanTopicUrl, parsePrivateKey } from "./client";

export interface StoredAuctionTopic {
  topicId: string;
  submitKey: string;
}

export async function publishToTopic(
  client: Client,
  topicId: string,
  submitKey: PrivateKey | string,
  message: Record<string, unknown>,
): Promise<void> {
  const key =
    typeof submitKey === "string" ? parsePrivateKey(submitKey) : submitKey;
  const transaction = new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(JSON.stringify(message))
    .freezeWith(client);
  await transaction.sign(key);
  const response = await transaction.execute(client);
  await response.getReceipt(client);
}

/**
 * A public, replayable HCS record. Every topic has a fresh submit key, so
 * outsiders cannot inject bids or settlement messages. The payer account
 * remains visible in Mirror Node responses and is validated by readers.
 */
export class AuctionLog {
  private constructor(
    readonly topicId: string,
    readonly submitKey: PrivateKey,
    private readonly client: Client,
  ) {}

  static async create(client: Client): Promise<AuctionLog> {
    const submitKey = PrivateKey.generateED25519();
    const response = await new TopicCreateTransaction()
      .setTopicMemo("pastel-de-nata auction log")
      .setSubmitKey(submitKey.publicKey)
      .execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.topicId) {
      throw new Error("Hedera did not return the topic id.");
    }
    return new AuctionLog(receipt.topicId.toString(), submitKey, client);
  }

  static fromStored(
    client: Client,
    topic: StoredAuctionTopic,
  ): AuctionLog {
    return new AuctionLog(
      topic.topicId,
      parsePrivateKey(topic.submitKey),
      client,
    );
  }

  async publish(message: Record<string, unknown>): Promise<void> {
    await publishToTopic(this.client, this.topicId, this.submitKey, message);
  }

  get submitKeyDer(): string {
    return this.submitKey.toStringDer();
  }

  get stored(): StoredAuctionTopic {
    return {
      topicId: this.topicId,
      submitKey: this.submitKeyDer,
    };
  }

  get url(): string {
    return hashscanTopicUrl(this.topicId);
  }
}
