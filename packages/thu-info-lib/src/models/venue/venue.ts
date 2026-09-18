export interface VenueScene {
    uuid: string;
    sceneName: string;
    relatedType?: string;
    location?: string;
    openTime?: string;
}

export interface VenueSite {
    uuid: string;
    siteName: string;
    siteType: string; // BUILDING / FLOOR / ROOM
}

export interface VenueRoom extends VenueSite {
    building?: string;
    floor?: string;
}

export interface VenueDayPeriod {
    currentDate: string;
    openStatus?: string;
    reserveStatus?: string;
    reserveStatusReason?: string;
    /** 原始时段数据（各场馆配置差异大，保持透传） */
    reserveInfo: unknown[];
}
