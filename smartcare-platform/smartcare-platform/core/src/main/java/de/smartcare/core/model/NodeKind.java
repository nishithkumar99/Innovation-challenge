package de.smartcare.core.model;

/** Station kinds match the UI's StationKind; JUNCTION is a pure routing node. LAB and CSSD are kept for older maps. */
public enum NodeKind { JUNCTION, PHARMACY, LAB, CSSD, WARD, OR, CHARGING, STORAGE, KITCHEN, LAUNDRY, WASTE, CHECKIN }
