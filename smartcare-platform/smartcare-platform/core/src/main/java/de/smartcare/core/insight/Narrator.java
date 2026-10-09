package de.smartcare.core.insight;

/** Turns structured facts about an insight into plain language for non-operators. Must never trigger actions. */
public interface Narrator {
    /** @return a short sentence, or null if unavailable (the caller keeps its rule-based text). */
    String narrate(String category, String ruleBasedText, String facts);
}
