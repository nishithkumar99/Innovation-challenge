package de.smartcare.core.settings;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.function.Function;

/**
 * Binds {@code smartcare.<section>.<field>} properties onto {@link Settings}. Both kebab-case ({@code order-ack-timeout-s})
 * and camelCase names are accepted. The lookup function is supplied by the host (Spring {@code Environment}, a Map in tests).
 */
public final class SettingsBinder {
    private SettingsBinder() {}

    public static Settings bind(Function<String, String> lookup) { return bind(new Settings(), lookup); }

    public static Settings bind(Settings target, Function<String, String> lookup) {
        try {
            for (Field section : Settings.class.getFields()) {
                if (Modifier.isStatic(section.getModifiers())) continue;
                Object sectionObj = section.get(target);
                for (Field f : sectionObj.getClass().getFields()) {
                    if (Modifier.isStatic(f.getModifiers()) || Modifier.isFinal(f.getModifiers())) continue;
                    String raw = firstNonNull(lookup, "smartcare." + section.getName() + "." + kebab(f.getName()),
                            "smartcare." + section.getName() + "." + f.getName());
                    if (raw == null) continue;
                    f.set(sectionObj, convert(raw.trim(), f.getType(), section.getName() + "." + f.getName()));
                }
            }
        } catch (IllegalAccessException e) { throw new IllegalStateException(e); }
        return target;
    }

    private static String firstNonNull(Function<String, String> lookup, String... keys) {
        for (String k : keys) { String v = lookup.apply(k); if (v != null) return v; }
        return null;
    }

    static String kebab(String camel) {
        StringBuilder sb = new StringBuilder();
        for (char c : camel.toCharArray()) { if (Character.isUpperCase(c)) sb.append('-').append(Character.toLowerCase(c)); else sb.append(c); }
        return sb.toString();
    }

    private static Object convert(String v, Class<?> t, String name) {
        try {
            if (t == String.class) return v;
            if (t == int.class) return Integer.parseInt(v);
            if (t == long.class) return Long.parseLong(v);
            if (t == double.class) return Double.parseDouble(v);
            if (t == boolean.class) {
                if (!v.equalsIgnoreCase("true") && !v.equalsIgnoreCase("false")) throw new NumberFormatException("not a boolean");
                return Boolean.parseBoolean(v);
            }
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Invalid value '" + v + "' for smartcare." + name + ": " + e.getMessage());
        }
        throw new IllegalArgumentException("Unsupported setting type " + t + " for " + name);
    }
}
