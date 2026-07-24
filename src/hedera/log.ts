import {
  Client,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import { hashscanTopicUrl } from "./client.js";

export async function publishToTopic(
  client: Client,
  topicId: string,
  message: Record<string, unknown>,
): Promise<void> {
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(JSON.stringify(message))
    .execute(client);
  await response.getReceipt(client);
}

/**
 * A public, replayable HCS record of one plan's auctions. Only data already
 * visible to sellers goes here: commitments, revealed winning amounts, and
 * settlement transaction ids. Never the intent, the global budget, or a
 * category cap.
 */
export class AuctionLog {
  private constructor(
    readonly topicId: string,
    private readonly client: Client,
  ) {}

  static async create(client: Client): Promise<AuctionLog> {
    const response = await new TopicCreateTransaction()
      .setTopicMemo("pastel-de-nata auction log")
      .execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.topicId) {
      throw new Error("Hedera did not return the topic id.");
    }
    return new AuctionLog(receipt.topicId.toString(), client);
  }

  async publish(message: Record<string, unknown>): Promise<void> {
    await publishToTopic(this.client, this.topicId, message);
  }

  get url(): string {
    return hashscanTopicUrl(this.topicId);
  }
}
