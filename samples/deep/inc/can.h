#ifndef CAN_H
#define CAN_H

typedef struct {
    unsigned int  id;
    unsigned char data[8];
    unsigned char len;
} CanFrame;

typedef struct {
    void (*shift_up)(void);
    void (*shift_down)(void);
    int  (*apply)(unsigned char, void *);
} ShiftOps;

extern const ShiftOps g_ops_4at;

#ifdef CONFIG_4WD
extern const ShiftOps g_ops_cvt;
#endif

void Can_Init(void);
unsigned int Can_GetRpm(void);
unsigned int Can_GetSpeed(void);
int  Can_SendGearStatus(unsigned char gear);
int  Can_SendFrame(const CanFrame *f);

#endif
