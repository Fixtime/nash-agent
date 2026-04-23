import { db } from "./db";
import { analyses, type Analysis, type InsertAnalysis } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

export interface IStorage {
  createAnalysis(data: InsertAnalysis): Analysis;
  getAnalysis(id: number): Analysis | undefined;
  listAnalyses(): Analysis[];
  updateAnalysisResult(id: number, result: string, status: string): Analysis | undefined;
  deleteAnalysis(id: number): Analysis | undefined;
}

export class Storage implements IStorage {
  createAnalysis(data: InsertAnalysis): Analysis {
    return db.insert(analyses).values(data).returning().get();
  }

  getAnalysis(id: number): Analysis | undefined {
    return db.select().from(analyses).where(eq(analyses.id, id)).get();
  }

  listAnalyses(): Analysis[] {
    return db.select().from(analyses).orderBy(desc(analyses.createdAt)).all();
  }

  updateAnalysisResult(id: number, result: string, status: string): Analysis | undefined {
    return db
      .update(analyses)
      .set({ result, status })
      .where(eq(analyses.id, id))
      .returning()
      .get();
  }

  deleteAnalysis(id: number): Analysis | undefined {
    const existing = this.getAnalysis(id);
    if (!existing) {
      return undefined;
    }

    db.delete(analyses).where(eq(analyses.id, id)).run();
    return existing;
  }
}

export const storage = new Storage();
