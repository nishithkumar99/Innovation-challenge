package de.smartcare.core.vda;

/** VDA 5050 topic names: {interfaceName}/{majorVersion}/{manufacturer}/{serialNumber}/{topic}. */
public final class Topics {
    private final String prefix;

    public Topics(String interfaceName, String majorVersion) { this.prefix = interfaceName + "/" + majorVersion + "/"; }

    private String of(String manufacturer, String serial, String topic) { return prefix + manufacturer + "/" + serial + "/" + topic; }
    public String order(String m, String s) { return of(m, s, "order"); }
    public String instantActions(String m, String s) { return of(m, s, "instantActions"); }
    public String state(String m, String s) { return of(m, s, "state"); }
    public String connection(String m, String s) { return of(m, s, "connection"); }
    public String visualization(String m, String s) { return of(m, s, "visualization"); }

    public String allStates() { return prefix + "+/+/state"; }
    public String allConnections() { return prefix + "+/+/connection"; }
    public String allOrders() { return prefix + "+/+/order"; }
    public String allInstantActions() { return prefix + "+/+/instantActions"; }

    /** Splits "uagv/v2/maker/serial/state" into {maker, serial, topic}; null if the topic does not match the prefix. */
    public String[] parse(String topic) {
        if (!topic.startsWith(prefix)) return null;
        String[] p = topic.substring(prefix.length()).split("/");
        return p.length == 3 ? p : null;
    }
}
