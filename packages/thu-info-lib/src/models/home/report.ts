export interface Course {
    name: string;
    credit: number;
    grade: string;
    point: number;
    semester: string;
    /** 课程性质（必修/限选/任选），来自必限统计页；抓取失败时缺省 */
    type?: string;
}
