import type { Response } from "express";
import type { SimulationEvent } from "../shared/types.js";

export class EventBus {
  private readonly clients = new Set<Response>();

  addClient(response: Response): void {
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  publish(event: SimulationEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  heartbeat(): void {
    for (const client of this.clients) {
      client.write(": heartbeat\n\n");
    }
  }
}
