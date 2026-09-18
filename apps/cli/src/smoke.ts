import type { SessionManager } from "@thu-agent/core";

// 气膜馆羽毛球场（sportsIdInfoList[0]），硬编码避免跨包子路径 import
const QIMO_BADMINTON = { gymId: "3998000", itemId: "4045681" };

/**
 * Offline smoke test: run every mock-safe read tool against the mock account.
 *
 * Write operations are intentionally excluded (they belong to Phase 2's
 * confirmation-gate tests). Methods that bypass the lib's mock wrapper and hit
 * the network even with the mock account are excluded too:
 *   news subscription/favor suite, network.ts (usereg) suite,
 *   getEleRechargePayCode, getCrCaptchaUrl, loginCr, reservesLibDownloadChapters.
 */

interface Case {
    name: string;
    fn: (h: import("@thu-info/lib").InfoHelper) => Promise<unknown>;
    /** optional: failure is a warning, not an error (mock data uncertain) */
    soft?: boolean;
}

const cases: Case[] = [
    // 门户/学业
    { name: "getUserInfo", fn: (h) => h.getUserInfo() },
    { name: "getReport", fn: (h) => h.getReport(false, true, 1) },
    { name: "getAssessmentList", fn: (h) => h.getAssessmentList() },
    { name: "getPhysicalExamResult", fn: (h) => h.getPhysicalExamResult(), soft: true },
    { name: "getClassroomList", fn: (h) => h.getClassroomList(), soft: true },
    { name: "getInvoiceList", fn: (h) => h.getInvoiceList(1) },
    { name: "getBankPayment", fn: (h) => h.getBankPayment(false, true), soft: true },
    { name: "getCalendar", fn: (h) => h.getCalendar() },
    { name: "getCalendarYear", fn: (h) => h.getCalendarYear() },
    { name: "getCountdown", fn: (h) => h.getCountdown(), soft: true },
    // 课表
    { name: "getSchedule", fn: (h) => h.getSchedule() },
    // 选课（只读）
    { name: "getCrTimetable", fn: (h) => h.getCrTimetable() },
    { name: "getCrAvailableSemesters", fn: (h) => h.getCrAvailableSemesters() },
    {
        name: "getCrCoursePlan",
        fn: async (h) => h.getCrCoursePlan((await h.getCrAvailableSemesters())[0]?.id ?? ""),
        soft: true,
    },
    // 图书馆
    { name: "getLibraryList", fn: (h) => h.getLibraryList() },
    { name: "getBookingRecords", fn: (h) => h.getBookingRecords(), soft: true },
    { name: "getLibraryRoomBookingInfoList", fn: (h) => h.getLibraryRoomBookingInfoList(), soft: true },
    { name: "getLibraryRoomBookingRecord", fn: (h) => h.getLibraryRoomBookingRecord(), soft: true },
    { name: "fuzzySearchLibraryId", fn: (h) => h.fuzzySearchLibraryId("张三"), soft: true },
    // 体育
    {
        name: "getSportsResources",
        fn: (h) => h.getSportsResources(QIMO_BADMINTON.gymId, QIMO_BADMINTON.itemId, new Date().toISOString().slice(0, 10)),
    },
    { name: "getSportsReservationRecords", fn: (h) => h.getSportsReservationRecords() },
    // 新闻（只读子集）
    { name: "getNewsList", fn: (h) => h.getNewsList(1, 5) },
    { name: "searchNewsList", fn: (h) => h.searchNewsList(1, "清华") },
    { name: "getNewsSourceList", fn: (h) => h.getNewsSourceList() },
    // getNewsChannelList 绕过 mock 包装直连网络（lib 已知缺口），mock 下预期失败
    { name: "getNewsChannelList", fn: (h) => h.getNewsChannelList(false), soft: true },
    // 宿舍
    { name: "getEleRemainder", fn: (h) => h.getEleRemainder(), soft: true },
    { name: "getElePayRecord", fn: (h) => h.getElePayRecord(), soft: true },
    // 校园卡（读）
    { name: "loginCampusCard", fn: (h) => h.loginCampusCard() },
    { name: "getCampusCardInfo", fn: (h) => h.getCampusCardInfo() },
    {
        name: "getCampusCardTransactions",
        fn: (h) => {
            const end = new Date().toISOString().slice(0, 10);
            const start = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
            return h.getCampusCardTransactions(start, end, -1);
        },
    },
    // 校园网（只读 URL 构建）
    { name: "getNetworkVerificationImageUrl", fn: (h) => h.getNetworkVerificationImageUrl() },
    // THOS
    { name: "prepareThosSession", fn: (h) => h.prepareThosSession(), soft: true },
    { name: "getThosTasks", fn: (h) => h.getThosTasks("active"), soft: true },
    { name: "getThosServices", fn: (h) => h.getThosServices(), soft: true },
    { name: "getScoreByCourseId", fn: (h) => h.getScoreByCourseId("10000012"), soft: true },
    // 培养方案
    { name: "getDegreeProgramCompletion", fn: (h) => h.getDegreeProgramCompletion(), soft: true },
    { name: "getFullDegreeProgram", fn: (h) => h.getFullDegreeProgram(), soft: true },
    // 教参平台
    { name: "searchReservesLib", fn: (h) => h.searchReservesLib("数学"), soft: true },
    // GitLab
    { name: "getGitNamespaces", fn: (h) => h.getGitNamespaces(1), soft: true },
    { name: "getGitRecentProjects", fn: (h) => h.getGitRecentProjects(1), soft: true },
    { name: "searchGitProjects", fn: (h) => h.searchGitProjects("test", 1), soft: true },
    // app 后端
    { name: "getLatestAnnounces", fn: (h) => h.getLatestAnnounces() },
    { name: "getLatestVersion", fn: (h) => h.getLatestVersion("android") },
    { name: "getFeedbackReplies", fn: (h) => h.getFeedbackReplies(), soft: true },
    { name: "getWeChatGroupQRCodeContent", fn: (h) => h.getWeChatGroupQRCodeContent(), soft: true },
];

export async function runSmoke(session: SessionManager): Promise<number> {
    let pass = 0;
    let softFail = 0;
    const failures: string[] = [];

    for (const c of cases) {
        try {
            await session.run(`smoke:${c.name}`, "read", c.fn);
            pass++;
            console.log(`  ✓ ${c.name}`);
        } catch (e) {
            if (c.soft) {
                softFail++;
                console.log(`  ⚠ ${c.name}: ${(e as Error).message}`);
            } else {
                failures.push(c.name);
                console.log(`  ✗ ${c.name}: ${(e as Error).message}`);
            }
        }
    }

    console.log(
        `\n结果: ${pass} 通过 / ${softFail} 软失败(允许) / ${failures.length} 失败` +
            (failures.length ? ` — ${failures.join(", ")}` : ""),
    );
    return failures.length > 0 ? 1 : 0;
}
