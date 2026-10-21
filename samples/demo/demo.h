#ifndef DEMO_H
#define DEMO_H

/* 测试样本的公共头文件：类型、宏、全局变量声明都在这里 */

#define MAX_RETRY        3u
#define GEAR_COUNT       4u
#define ADC_CHANNELS     8u
#define RX_BUF_SIZE      64u

#define ABS(x)           ((x) < 0 ? -(x) : (x))
#define CLAMP(v, lo, hi) ((v) < (lo) ? (lo) : ((v) > (hi) ? (hi) : (v)))

/* 宏体里含函数调用 → 解析器会展开成 macro 边（对照 tcu 的 SET_GEAR） */
#define SET_GEAR(g)      Gear_Apply((g))

typedef struct {
    unsigned char target;
    unsigned char current;
    unsigned short shiftCnt;
    unsigned short retry;
    unsigned char fault;
    unsigned char ready;
} GearCtx;

typedef struct {
    unsigned short raw[ADC_CHANNELS];
    unsigned short filtered[ADC_CHANNELS];
    unsigned char  valid;
    unsigned char  channel;
} SensorState;

typedef struct {
    unsigned short magic;
    unsigned char  gear;
    unsigned char  checksum;
    unsigned int   writeCnt;
} NvmBlock;

typedef struct {
    unsigned char upSpeed;
    unsigned char downSpeed;
    unsigned char minRpm;
    unsigned char maxRpm;
} ShiftOps;

typedef void (*DiagHook)(unsigned char code);

/* 函数指针表：成员是函数指针，用带指定初始化的形式定义，
   配合 INVOKE 宏调用 —— 解析器会识别成 fnptr 边（对照 tcu 的 ShiftOps） */
typedef struct {
    void (*up)(void);
    void (*down)(void);
} GearOps;

/* ---- 全局变量 / 常量 ---- */
extern GearCtx       g_gear;
extern SensorState   g_sensor;
extern NvmBlock      g_nvm;
extern volatile unsigned int g_tick;
extern unsigned short g_rpm;
extern unsigned short g_speed;
extern int            g_faultCode;
extern unsigned char  g_rxBuf[RX_BUF_SIZE];
extern unsigned char  g_rxLen;
extern unsigned char  g_ignition;
extern const ShiftOps g_shiftTable[GEAR_COUNT];
extern const unsigned char g_dtcTable[8];
extern DiagHook       g_diagHook;
extern const GearOps  g_gearOps;

/* 通过函数指针表调用成员的宏：展开后形如 (&g_gearOps)->up() */
#define INVOKE(ops, m)  ((ops)->m())

/* ---- 对外接口 ---- */
void App_Init(void);
void Shift_Init(void);
void Shift_Check(unsigned short rpm, unsigned short speed);
void Diag_Init(void);
void Diag_Task(void);
int  Gear_Apply(unsigned char target);
void Gear_SelfTest(void);
void Adc_Start(void);
void Pwm_Update(void);
void App_Task10ms(void);
void App_Task100ms(void);
void Can_Init(void);
void Can_SendGearStatus(void);
void Can_Poll(void);
void Nvm_Init(void);
void Nvm_Save(void);
void Nvm_Load(void);
void Timer_Init(void);
void Timer_Isr(void);
void Adc_Init(void);
void Adc_Start(void);
unsigned short Adc_Get(unsigned char ch);
void Pwm_Init(void);
void Pwm_SetDuty(unsigned char ch, unsigned char duty);
void Diag_Report(unsigned char code);

#endif /* DEMO_H */
