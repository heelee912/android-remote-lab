package lab.arcguard;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public final class KeepaliveCandidateTest {
    @Test public void candidateBundleKeepsSixteenIndependentCards() {
        assertEquals(16, KeepaliveCandidate.values().length);
    }

    @Test public void candidateIdsAreStableAndUnique() {
        Set<String> ids = new HashSet<>();
        for (KeepaliveCandidate candidate : KeepaliveCandidate.values()) {
            assertTrue(ids.add(candidate.id));
        }
    }

    @Test public void bundleContainsOnlyNonDisruptiveInteractionClasses() {
        Set<KeepaliveCandidate.Interaction> allowed = new HashSet<>(Arrays.asList(
                KeepaliveCandidate.Interaction.READ_ONLY,
                KeepaliveCandidate.Interaction.IDEMPOTENT,
                KeepaliveCandidate.Interaction.SAME_INPUT));
        for (KeepaliveCandidate candidate : KeepaliveCandidate.values()) {
            assertTrue(allowed.contains(candidate.interaction));
        }
    }
}
